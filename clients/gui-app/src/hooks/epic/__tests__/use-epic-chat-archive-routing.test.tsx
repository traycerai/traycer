/**
 * Archive and delete must address the chat's owning host, not the viewing
 * epic session. A local epic list can include foreign replicas; writing those
 * through the session host is the defect this suite pins.
 *
 * Drives the real hooks against a real `HostClient` over `MockHostMessenger`,
 * a real `QueryClient`, and a real open-epic store.
 */
import { type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockInProcessHostEntry,
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  DeleteChatRequest,
  SetChatArchivedRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  useEpicArchiveChat,
  useEpicArchiveChats,
  useEpicDeleteChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import {
  invalidateEpicChatRecords,
  useEpicSyncChatRecords,
} from "@/hooks/chats/use-epic-chat-records";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useAuthStore } from "@/stores/auth/auth-store";
import { hostQueryKeys } from "@/lib/query-keys";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "sonner";

const LOCAL = mockLocalHostEntry;
const REMOTE = mockRemoteHostEntry;
const OTHER = mockInProcessHostEntry;
const DIRECTORY: readonly HostDirectoryEntry[] = [LOCAL, REMOTE, OTHER];
const EPIC_ID = "epic-routing-test";
const VIEWER_ID = "viewer-routing";
const REMOTE_CHAT_ID = "chat-remote";
const LOCAL_CHAT_ID = "chat-local";

const spineRef = vi.hoisted<{
  value: HostClient<HostRpcRegistry> | null;
}>(() => ({ value: null }));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () =>
    spineRef.value === null
      ? null
      : { hostClient: spineRef.value, hostId: null },
  useHostRuntimeClient: () => spineRef.value,
  useHostClient: () =>
    spineRef.value?.createRequesterForHostId(LOCAL.hostId) ?? null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    spineRef.value === null
      ? null
      : { hostClient: spineRef.value, hostId: null },
  useHostRuntimeClient: () => spineRef.value,
  useHostClient: () =>
    spineRef.value?.createRequesterForHostId(LOCAL.hostId) ?? null,
}));

interface MutationCall {
  readonly hostId: string;
  readonly params: unknown;
}

interface RoutingFixture {
  readonly spine: HostClient<HostRpcRegistry>;
  readonly localClient: HostClient<HostRpcRegistry>;
  readonly remoteClient: HostClient<HostRpcRegistry>;
  readonly otherClient: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly handle: OpenedStoreForTest;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly localRecords: ChatRecordSummaryV11[];
  readonly remoteRecords: ChatRecordSummaryV11[];
  readonly viewerForeign: ChatRecordSummaryV11[];
  readonly archiveCalls: MutationCall[];
  readonly deleteCalls: MutationCall[];
  readonly listCallsByHost: Record<string, number>;
  holdRemoteArchive: Promise<unknown> | null;
  holdRemoteDelete: Promise<unknown> | null;
  failRemoteArchive: boolean;
  failRemoteList: boolean;
  readonly swapSession: (client: HostClient<HostRpcRegistry>) => void;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly dispose: () => void;
}

function record(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "chat-1",
    ownerUserId: VIEWER_ID,
    originHostId: LOCAL.hostId,
    title: "",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    ...overrides,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Epic routing",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: VIEWER_ID,
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: VIEWER_ID,
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return handle;
}

function lastCallHost(messenger: MockHostMessenger<HostRpcRegistry>): string {
  if (messenger.calls.length === 0) {
    throw new Error("expected a host messenger call");
  }
  return messenger.calls[messenger.calls.length - 1].authority.endpoint.hostId;
}

function bumpArchived(
  rows: ChatRecordSummaryV11[],
  chatId: string,
  archived: boolean,
): void {
  const index = rows.findIndex((entry) => entry.chatId === chatId);
  if (index < 0) return;
  rows[index] = {
    ...rows[index],
    archived,
    archivedAt: archived ? 5 : null,
    revision: rows[index].revision + 1,
  };
}

function createRoutingFixture(): RoutingFixture {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const localRecords: ChatRecordSummaryV11[] = [];
  const remoteRecords: ChatRecordSummaryV11[] = [];
  const viewerForeign: ChatRecordSummaryV11[] = [];
  const archiveCalls: MutationCall[] = [];
  const deleteCalls: MutationCall[] = [];
  const listCallsByHost: Record<string, number> = {};
  const sessionSlot: { current: HostClient<HostRpcRegistry> | null } = {
    current: null,
  };
  const sessionListeners = new Set<() => void>();
  const mutable: {
    holdRemoteArchive: Promise<unknown> | null;
    holdRemoteDelete: Promise<unknown> | null;
    failRemoteArchive: boolean;
    failRemoteList: boolean;
  } = {
    holdRemoteArchive: null,
    holdRemoteDelete: null,
    failRemoteArchive: false,
    failRemoteList: false,
  };

  const requestSeq = { value: 0 };
  const messengerRef: { current: MockHostMessenger<HostRpcRegistry> | null } = {
    current: null,
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq.value += 1;
      return `routing-${String(requestSeq.value)}`;
    },
    handlers: {
      "epic.listChatRecords": () => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        listCallsByHost[hostId] = (listCallsByHost[hostId] ?? 0) + 1;
        if (hostId === LOCAL.hostId) {
          return {
            chats: [
              ...localRecords.map((row) => ({ ...row })),
              ...viewerForeign.map((row) => ({ ...row })),
            ],
          };
        }
        if (hostId === REMOTE.hostId) {
          if (mutable.failRemoteList) {
            throw new HostRpcError({
              code: "RPC_ERROR",
              message: "owner list failed",
              requestId: "remote-list-failed",
              method: "epic.listChatRecords",
              fatalDetails: null,
            });
          }
          return { chats: remoteRecords.map((row) => ({ ...row })) };
        }
        return { chats: [] };
      },
      "epic.setChatArchived": (request: SetChatArchivedRequest) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        archiveCalls.push({ hostId, params: request });
        if (hostId === REMOTE.hostId) {
          if (mutable.failRemoteArchive) {
            throw new HostRpcError({
              code: "RPC_ERROR",
              message: "RECORD_NOT_FOUND: epic.setChatArchived found no chat",
              requestId: "remote-archive-missing",
              method: "epic.setChatArchived",
              fatalDetails: null,
            });
          }
          bumpArchived(remoteRecords, request.chatId, request.archived);
          if (mutable.holdRemoteArchive !== null) {
            return mutable.holdRemoteArchive.then(() => ({ updated: true }));
          }
          return { updated: true };
        }
        bumpArchived(localRecords, request.chatId, request.archived);
        return { updated: true };
      },
      "epic.deleteChat": (request: DeleteChatRequest) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        deleteCalls.push({ hostId, params: request });
        if (hostId === REMOTE.hostId) {
          const index = remoteRecords.findIndex(
            (entry) => entry.chatId === request.chatId,
          );
          if (index >= 0) remoteRecords.splice(index, 1);
          if (mutable.holdRemoteDelete !== null) {
            return mutable.holdRemoteDelete.then(() => ({ deleted: true }));
          }
          return { deleted: true };
        }
        const index = localRecords.findIndex(
          (entry) => entry.chatId === request.chatId,
        );
        if (index >= 0) localRecords.splice(index, 1);
        return { deleted: true };
      },
    },
  });
  messengerRef.current = messenger;

  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      DIRECTORY.find((entry) => entry.hostId === hostId) ?? null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "archive-routing-token",
    }),
  );
  const localClient = spine.createRequester(LOCAL);
  const remoteClient = spine.createRequester(REMOTE);
  const otherClient = spine.createRequester(OTHER);
  sessionSlot.current = localClient;
  spineRef.value = spine;
  const handle = newSession();

  const swapSession = (client: HostClient<HostRpcRegistry>): void => {
    sessionSlot.current = client;
    for (const listener of sessionListeners) listener();
  };

  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => {
    const sessionClient = useSyncExternalStore(
      (listener) => {
        sessionListeners.add(listener);
        return () => {
          sessionListeners.delete(listener);
        };
      },
      () => sessionSlot.current,
    );
    return (
      <QueryClientProvider client={queryClient}>
        <EpicSessionContext.Provider value={handle}>
          <EpicSessionHostClientContext.Provider value={sessionClient}>
            {props.children}
          </EpicSessionHostClientContext.Provider>
        </EpicSessionContext.Provider>
      </QueryClientProvider>
    );
  };

  const dispose = (): void => {
    handle.store.getState().dispose();
    spine.dispose();
    spineRef.value = null;
  };

  return {
    spine,
    localClient,
    remoteClient,
    otherClient,
    queryClient,
    handle,
    messenger,
    localRecords,
    remoteRecords,
    viewerForeign,
    archiveCalls,
    deleteCalls,
    listCallsByHost,
    get holdRemoteArchive() {
      return mutable.holdRemoteArchive;
    },
    set holdRemoteArchive(value: Promise<unknown> | null) {
      mutable.holdRemoteArchive = value;
    },
    get holdRemoteDelete() {
      return mutable.holdRemoteDelete;
    },
    set holdRemoteDelete(value: Promise<unknown> | null) {
      mutable.holdRemoteDelete = value;
    },
    get failRemoteArchive() {
      return mutable.failRemoteArchive;
    },
    set failRemoteArchive(value: boolean) {
      mutable.failRemoteArchive = value;
    },
    get failRemoteList() {
      return mutable.failRemoteList;
    },
    set failRemoteList(value: boolean) {
      mutable.failRemoteList = value;
    },
    swapSession,
    wrapper: Wrapper,
    dispose,
  };
}

let fixture: RoutingFixture;

beforeEach(() => {
  useAuthStore.getState().setSignedIn(
    {
      userId: VIEWER_ID,
      userName: VIEWER_ID,
      email: `${VIEWER_ID}@example.com`,
    },
    { userId: VIEWER_ID, username: VIEWER_ID },
    [],
  );
  fixture = createRoutingFixture();
});

afterEach(() => {
  cleanup();
  fixture.dispose();
  useAuthStore.getState().setSignedOut();
});

function seedRemoteChat(): void {
  const remoteRow = record({
    chatId: REMOTE_CHAT_ID,
    originHostId: REMOTE.hostId,
    title: "Access X Saved Bookmarks",
    origin: "own",
  });
  fixture.remoteRecords.push(remoteRow);
  fixture.viewerForeign.push({
    ...remoteRow,
    origin: "foreign",
  });
}

function seedLocalChat(): void {
  fixture.localRecords.push(
    record({ chatId: LOCAL_CHAT_ID, title: "Local chat" }),
  );
}

async function settleViewerList(): Promise<void> {
  await waitFor(() => {
    expect(fixture.listCallsByHost[LOCAL.hostId]).toBeGreaterThanOrEqual(1);
  });
  await waitFor(() => {
    expect(fixture.handle.store.getState().chatRecordListAuthoritative).toBe(
      true,
    );
  });
}

describe("useEpicArchiveChat session routing", () => {
  it("dispatches a same-host archive through the session client and strips hostId", async () => {
    const { result } = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: LOCAL_CHAT_ID,
        hostId: LOCAL.hostId,
        archived: true,
      });
    });

    expect(fixture.archiveCalls).toEqual([
      {
        hostId: LOCAL.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: LOCAL_CHAT_ID,
          archived: true,
        },
      },
    ]);
  });
});

describe("remote archive and unarchive", () => {
  it("archives a remote chat on the owning host, not the viewing session", async () => {
    seedRemoteChat();
    const invalidateQueries = vi.spyOn(
      fixture.queryClient,
      "invalidateQueries",
    );
    const { result } = renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        return useEpicArchiveChat();
      },
      { wrapper: fixture.wrapper },
    );
    await settleViewerList();

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: true,
      });
    });

    expect(fixture.archiveCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: REMOTE_CHAT_ID,
          archived: true,
        },
      },
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(
        REMOTE.hostId,
        "epic.listChatRecords",
      ),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(LOCAL.hostId, "epic.listChatRecords"),
    });
    // The viewing host's replica is not updated by the owning write. A later
    // list from the viewer can still carry the pre-archive row.
    expect(
      fixture.viewerForeign.find((row) => row.chatId === REMOTE_CHAT_ID)
        ?.archived,
    ).toBe(false);
    await waitFor(() => {
      // Owner timestamp is stripped when the row is applied as a foreign
      // replica; a non-null projected time is the archived boolean.
      expect(
        fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID].archivedAt,
      ).not.toBeNull();
    });
  });

  it("keeps a remote archive in the viewer store when a stale foreign list arrives, then applies a later unarchive", async () => {
    seedRemoteChat();
    const { result } = renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        return useEpicArchiveChat();
      },
      { wrapper: fixture.wrapper },
    );
    await settleViewerList();
    const listsAfterSeed = fixture.listCallsByHost[LOCAL.hostId] ?? 0;

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: true,
      });
    });

    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID].archivedAt,
      ).not.toBeNull();
    });
    expect(
      fixture.viewerForeign.find((row) => row.chatId === REMOTE_CHAT_ID)
        ?.archived,
    ).toBe(false);

    await waitFor(() => {
      expect(fixture.listCallsByHost[LOCAL.hostId] ?? 0).toBeGreaterThan(
        listsAfterSeed,
      );
    });
    expect(
      fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID].archivedAt,
    ).not.toBeNull();

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: false,
      });
    });

    await waitFor(() => {
      expect(
        fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID].archivedAt,
      ).toBeNull();
    });
    expect(fixture.remoteRecords[0]?.revision).toBeGreaterThan(2);

    if (fixture.remoteRecords.length === 0) {
      throw new Error("expected the owning host to still hold the chat");
    }
    const delayedArchiveReplica = fixture.remoteRecords[0];
    fixture.viewerForeign.splice(0, fixture.viewerForeign.length, {
      ...delayedArchiveReplica,
      origin: "foreign",
      archived: true,
      archivedAt: 5,
      revision: 2,
    });
    const listsAfterUnarchive = fixture.listCallsByHost[LOCAL.hostId] ?? 0;
    invalidateEpicChatRecords(fixture.queryClient, LOCAL.hostId);
    await waitFor(() => {
      expect(fixture.listCallsByHost[LOCAL.hostId] ?? 0).toBeGreaterThan(
        listsAfterUnarchive,
      );
    });
    expect(
      fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID].archivedAt,
    ).toBeNull();
  });

  it("unarchives a remote chat on the owning host", async () => {
    seedRemoteChat();
    bumpArchived(fixture.remoteRecords, REMOTE_CHAT_ID, true);
    bumpArchived(fixture.viewerForeign, REMOTE_CHAT_ID, true);
    const { result } = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: false,
      });
    });

    expect(fixture.archiveCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: REMOTE_CHAT_ID,
          archived: false,
        },
      },
    ]);
    expect(fixture.remoteRecords[0]?.archived).toBe(false);
    expect(
      fixture.viewerForeign.find((row) => row.chatId === REMOTE_CHAT_ID)
        ?.archived,
    ).toBe(true);
  });

  it("still commits a remote archive when the owner list refresh fails", async () => {
    seedRemoteChat();
    fixture.failRemoteList = true;
    const { result } = renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        return useEpicArchiveChat();
      },
      { wrapper: fixture.wrapper },
    );
    await settleViewerList();

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: true,
      }),
    ).resolves.toEqual({ updated: true });

    expect(fixture.archiveCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: REMOTE_CHAT_ID,
          archived: true,
        },
      },
    ]);
    expect(toast.error).toHaveBeenCalledWith(
      "Agent updated, but couldn't refresh its status.",
    );
  });
});

describe("remote delete", () => {
  it("deletes on the owning host and never calls the viewing session", async () => {
    seedRemoteChat();
    seedLocalChat();
    const { result } = renderHook(() => useEpicDeleteChat(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
      });
    });

    expect(fixture.deleteCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: { epicId: EPIC_ID, chatId: REMOTE_CHAT_ID },
      },
    ]);
    expect(
      fixture.localRecords.some((row) => row.chatId === LOCAL_CHAT_ID),
    ).toBe(true);
  });
});

describe("failed or unavailable remote does not fall back", () => {
  it("does not archive on the session host when the remote write fails", async () => {
    seedRemoteChat();
    fixture.failRemoteArchive = true;
    const { result } = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: true,
      }),
    ).rejects.toBeInstanceOf(HostRpcError);

    expect(fixture.archiveCalls.map((call) => call.hostId)).toEqual([
      REMOTE.hostId,
    ]);
  });

  it("fails closed for a null host without dispatching anywhere", async () => {
    const { result } = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: null,
        archived: true,
      }),
    ).rejects.toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-unavailable",
      method: "epic.setChatArchived",
    });
    expect(fixture.archiveCalls).toEqual([]);
    expect(fixture.deleteCalls).toEqual([]);
  });

  it("does not fall back to the session host when the named host is unavailable", async () => {
    const { result } = renderHook(() => useEpicDeleteChat(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: "host-missing",
      }),
    ).rejects.toBeTruthy();
    expect(fixture.deleteCalls).toEqual([]);
  });
});

describe("mixed-host bulk archive", () => {
  it("routes each selected chat to its own host", async () => {
    seedLocalChat();
    seedRemoteChat();
    const { result } = renderHook(() => useEpicArchiveChats(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chats: [
          { chatId: LOCAL_CHAT_ID, hostId: LOCAL.hostId },
          { chatId: REMOTE_CHAT_ID, hostId: REMOTE.hostId },
        ],
        archived: true,
      });
    });

    expect(fixture.archiveCalls).toEqual([
      {
        hostId: LOCAL.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: LOCAL_CHAT_ID,
          archived: true,
        },
      },
      {
        hostId: REMOTE.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: REMOTE_CHAT_ID,
          archived: true,
        },
      },
    ]);
  });
});

describe("host swap in flight retains the target", () => {
  it("keeps sending to the captured host after the session host changes", async () => {
    seedRemoteChat();
    let resolveRemote: (value: unknown) => void = () => {
      throw new Error("remote archive resolver is unavailable");
    };
    fixture.holdRemoteArchive = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const invalidateQueries = vi.spyOn(
      fixture.queryClient,
      "invalidateQueries",
    );
    const { result } = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
        archived: true,
      });
    });

    act(() => {
      fixture.swapSession(fixture.otherClient);
    });
    resolveRemote(undefined);
    await act(async () => {
      await pending;
    });

    expect(fixture.archiveCalls.map((call) => call.hostId)).toEqual([
      REMOTE.hostId,
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(
        REMOTE.hostId,
        "epic.listChatRecords",
      ),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(LOCAL.hostId, "epic.listChatRecords"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(OTHER.hostId, "epic.listChatRecords"),
    });
  });
});

describe("delete projection stays removed against a stale foreign list", () => {
  it("does not resurrect a confirmed remote delete when the viewer list still carries the replica", async () => {
    seedRemoteChat();
    const { result } = renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        return useEpicDeleteChat();
      },
      { wrapper: fixture.wrapper },
    );
    await settleViewerList();
    expect(
      Object.hasOwn(fixture.handle.store.getState().chats.byId, REMOTE_CHAT_ID),
    ).toBe(true);

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
      });
    });

    await waitFor(() => {
      expect(
        Object.hasOwn(
          fixture.handle.store.getState().chats.byId,
          REMOTE_CHAT_ID,
        ),
      ).toBe(false);
    });
    expect(
      fixture.viewerForeign.some((row) => row.chatId === REMOTE_CHAT_ID),
    ).toBe(true);
    await waitFor(() => {
      expect(fixture.listCallsByHost[LOCAL.hostId]).toBeGreaterThanOrEqual(2);
    });
    expect(
      Object.hasOwn(fixture.handle.store.getState().chats.byId, REMOTE_CHAT_ID),
    ).toBe(false);
    expect(fixture.handle.store.getState().chatRetractions).toEqual({
      [REMOTE_CHAT_ID]: "deleted",
    });
  });
});
