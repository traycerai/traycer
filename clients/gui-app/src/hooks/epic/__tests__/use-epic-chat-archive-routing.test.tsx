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
import { useEpicDeleteTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicBatchDelete } from "@/hooks/epic/use-epic-batch-delete-mutation";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  deletedCloudEpicTasksPageEpicIdsForScope,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useCloudChatDeletions } from "@/lib/chats/cloud-chat-deletions";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  invalidateEpicChatRecords,
  useEpicSyncChatRecords,
} from "@/hooks/chats/use-epic-chat-records";
import {
  __getOpenEpicRegistryForTests,
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
    getToasts: vi.fn(() => []),
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
  useRouterState: (options: {
    readonly select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => options.select({ location: { pathname: "/epics" } }),
}));

vi.mock("@/lib/host/use-worktree-delete-stream-transport", () => ({
  useWorktreeDeleteStreamTransportFactory: () => () => null,
}));

import { toast } from "sonner";

const LOCAL = mockLocalHostEntry;
const REMOTE = mockRemoteHostEntry;
const OTHER = mockInProcessHostEntry;
/** Where a stand-in's `requested` answer says the record has moved. */
const MOVED: HostDirectoryEntry = {
  ...mockRemoteHostEntry,
  hostId: "mock-moved",
  label: "Moved Host",
};
const DIRECTORY: readonly HostDirectoryEntry[] = [LOCAL, REMOTE, OTHER, MOVED];

/**
 * How OTHER answers a write it is sent as a stand-in: it enacts it on its own
 * record (`applied`), files it for the owner it names (`requested`, naming
 * MOVED), or enacts it and then fails before the answer arrives (`lost`).
 */
const standIn: {
  answer: "applied" | "requested" | "lost";
  readonly batchDeleteCalls: string[];
  /** The terminal agents and Tasks OTHER holds: what a delete commits. */
  readonly tuiAgents: Set<string>;
  readonly tasks: Set<string>;
  /** Holds OTHER's terminal-agent delete until it settles, when set. */
  holdTuiDelete: Promise<void> | null;
} = {
  answer: "applied",
  batchDeleteCalls: [],
  tuiAgents: new Set(),
  tasks: new Set(),
  holdTuiDelete: null,
};

function lostAnswer(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "the answer was lost after the write",
    requestId: "stand-in-lost",
    method,
    fatalDetails: null,
  });
}
const EPIC_ID = "epic-routing-test";
const VIEWER_ID = "viewer-routing";
const REMOTE_CHAT_ID = "chat-remote";
const LOCAL_CHAT_ID = "chat-local";
const STALE_LIST_SENTINEL_ID = "chat-stale-sentinel";

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
  /** The records OTHER holds; it enacts a write on these and only these. */
  readonly otherRecords: ChatRecordSummaryV11[];
  readonly viewerForeign: ChatRecordSummaryV11[];
  readonly archiveCalls: MutationCall[];
  readonly deleteCalls: MutationCall[];
  readonly listCallsByHost: Record<string, number>;
  holdRemoteArchive: Promise<unknown> | null;
  holdRemoteDelete: Promise<unknown> | null;
  failRemoteArchive: boolean;
  failRemoteList: boolean;
  readonly swapSession: (client: HostClient<HostRpcRegistry>) => void;
  readonly replaceMountedOnto: (hostId: string) => OpenedStoreForTest;
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

function withHostId(
  handle: OpenedStoreForTest,
  hostId: string,
): OpenedStoreForTest {
  return {
    ...handle,
    hostId,
    get doc() {
      return handle.doc;
    },
    get awareness() {
      return handle.awareness;
    },
  };
}

function staleViewerReplica(): ChatRecordSummaryV11 {
  return record({
    chatId: REMOTE_CHAT_ID,
    originHostId: REMOTE.hostId,
    title: "Access X Saved Bookmarks",
    origin: "foreign",
  });
}

function deliverStaleList(
  handle: OpenedStoreForTest,
  rows: readonly ChatRecordSummaryV11[],
): void {
  const issuedAtSeq = handle.store.getState().peekChatIngestSeq();
  handle.store.getState().applyChatRecords(rows, issuedAtSeq);
}

function deliverStaleViewerList(handle: OpenedStoreForTest): void {
  deliverStaleList(handle, [
    staleViewerReplica(),
    record({
      chatId: STALE_LIST_SENTINEL_ID,
      originHostId: LOCAL.hostId,
      title: "Stale list sentinel",
      origin: "foreign",
    }),
  ]);
}

function deliverStaleTargetHostList(handle: OpenedStoreForTest): void {
  deliverStaleList(handle, [
    record({
      chatId: REMOTE_CHAT_ID,
      originHostId: REMOTE.hostId,
      title: "Access X Saved Bookmarks",
      origin: "own",
    }),
    record({
      chatId: STALE_LIST_SENTINEL_ID,
      originHostId: REMOTE.hostId,
      title: "Stale list sentinel",
      origin: "own",
    }),
  ]);
}

async function waitForStaleListApplied(
  handle: OpenedStoreForTest,
): Promise<void> {
  await waitFor(() => {
    expect(
      Object.hasOwn(handle.store.getState().chats.byId, STALE_LIST_SENTINEL_ID),
    ).toBe(true);
  });
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
  const otherRecords: ChatRecordSummaryV11[] = [];
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
            kind: "snapshot" as const,
            listStamp: null,
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
          return {
            kind: "snapshot" as const,
            listStamp: null,
            chats: remoteRecords.map((row) => ({ ...row })),
          };
        }
        return {
          kind: "snapshot" as const,
          listStamp: null,
          chats: otherRecords.map((row) => ({ ...row })),
        };
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
            return mutable.holdRemoteArchive.then(() => ({
              updated: true,
              outcome: "applied" as const,
            }));
          }
          return { updated: true, outcome: "applied" as const };
        }
        if (hostId === OTHER.hostId) {
          if (standIn.answer === "requested") {
            return {
              updated: true,
              outcome: "requested" as const,
              ownerHostId: MOVED.hostId,
            };
          }
          bumpArchived(otherRecords, request.chatId, request.archived);
          if (standIn.answer === "lost") {
            throw lostAnswer("epic.setChatArchived");
          }
          return { updated: true, outcome: "applied" as const };
        }
        bumpArchived(localRecords, request.chatId, request.archived);
        return { updated: true, outcome: "applied" as const };
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
            return mutable.holdRemoteDelete.then(() => ({
              deleted: true,
              publicationChatId: null,
              outcome: "applied" as const,
            }));
          }
          return {
            deleted: true,
            publicationChatId: null,
            outcome: "applied" as const,
          };
        }
        if (hostId === OTHER.hostId) {
          if (standIn.answer === "requested") {
            return {
              deleted: true,
              publicationChatId: request.chatId,
              outcome: "requested" as const,
              ownerHostId: MOVED.hostId,
            };
          }
          const index = otherRecords.findIndex(
            (entry) => entry.chatId === request.chatId,
          );
          if (index >= 0) otherRecords.splice(index, 1);
          if (standIn.answer === "lost") throw lostAnswer("epic.deleteChat");
          return {
            deleted: true,
            publicationChatId: request.chatId,
            outcome: "applied" as const,
          };
        }
        const index = localRecords.findIndex(
          (entry) => entry.chatId === request.chatId,
        );
        if (index >= 0) localRecords.splice(index, 1);
        return {
          deleted: true,
          publicationChatId: null,
          outcome: "applied" as const,
        };
      },
      "epic.deleteTuiAgent": (request: { readonly tuiAgentId: string }) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        if (hostId !== OTHER.hostId) {
          return { deleted: true, outcome: "applied" as const };
        }
        const answer = () => {
          if (standIn.answer === "requested") {
            return {
              deleted: true,
              outcome: "requested" as const,
              ownerHostId: MOVED.hostId,
            };
          }
          // OTHER holds the agent: the delete commits, whatever happens to
          // its answer.
          standIn.tuiAgents.delete(request.tuiAgentId);
          if (standIn.answer === "lost") {
            throw lostAnswer("epic.deleteTuiAgent");
          }
          return { deleted: true, outcome: "applied" as const };
        };
        return standIn.holdTuiDelete === null
          ? answer()
          : standIn.holdTuiDelete.then(answer);
      },
      "epic.batchDelete": (request: { readonly ids: readonly string[] }) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        standIn.batchDeleteCalls.push(hostId);
        // The purge commits, whatever happens to the answer.
        for (const taskId of request.ids) standIn.tasks.delete(taskId);
        if (standIn.answer === "lost") throw lostAnswer("epic.batchDelete");
        // OTHER held its own local-homed copy of each Task.
        return {
          results: request.ids.map((taskId) => ({
            taskId,
            success: true,
            home: "local" as const,
          })),
        };
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
  const registry = __getOpenEpicRegistryForTests();
  registry.disposeAll();
  const handle = withHostId(newSession(), LOCAL.hostId);
  registry.acquireMounted(EPIC_ID, () => handle);

  const swapSession = (client: HostClient<HostRpcRegistry>): void => {
    sessionSlot.current = client;
    for (const listener of sessionListeners) listener();
  };

  const replaceMountedOnto = (hostId: string): OpenedStoreForTest => {
    const outgoing = registry.peek(EPIC_ID);
    if (outgoing === null) {
      throw new Error("expected a mounted epic session");
    }
    const incoming = withHostId(newSession(), hostId);
    const replaced = registry.replaceMounted(EPIC_ID, outgoing, incoming, {
      hostStamp: outgoing.hostId,
      ownerIdentityKey: VIEWER_ID,
      editsTransferredToReplacement: false,
    });
    if (!replaced) {
      incoming.store.getState().dispose();
      throw new Error("replaceMounted refused the outgoing handle");
    }
    return incoming;
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
    registry.disposeAll();
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
    otherRecords,
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
    replaceMountedOnto,
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
    ).resolves.toEqual({ updated: true, outcome: "applied" });

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
          {
            chatId: LOCAL_CHAT_ID,
            hostId: LOCAL.hostId,
            selectedRows: 1,
            coveredRows: () => 1,
          },
          {
            chatId: REMOTE_CHAT_ID,
            hostId: REMOTE.hostId,
            selectedRows: 1,
            coveredRows: () => 1,
          },
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
    expect(fixture.handle.store.getState().chatRetractions).toEqual({});
  });
});

describe("replaceMounted during a delayed ACK", () => {
  it("archives onto an empty replacement and keeps it through a stale viewer list", async () => {
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

    const incoming = fixture.replaceMountedOnto(OTHER.hostId);
    expect(incoming.store.getState().snapshotLoaded).toBe(true);
    expect(incoming.store.getState().chats.allIds).toEqual([]);

    resolveRemote(undefined);
    await act(async () => {
      await pending;
    });

    await waitFor(() => {
      expect(
        incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.archivedAt,
      ).toBe(2);
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(OTHER.hostId, "epic.listChatRecords"),
    });

    deliverStaleViewerList(incoming);
    await waitForStaleListApplied(incoming);
    expect(
      incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.archivedAt,
    ).toBe(2);
  });

  it("applies the owner archive as own when the replacement is the owning host", async () => {
    seedRemoteChat();
    let resolveRemote: (value: unknown) => void = () => {
      throw new Error("remote archive resolver is unavailable");
    };
    fixture.holdRemoteArchive = new Promise((resolve) => {
      resolveRemote = resolve;
    });
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

    const incoming = fixture.replaceMountedOnto(REMOTE.hostId);
    expect(incoming.store.getState().chats.allIds).toEqual([]);

    resolveRemote(undefined);
    await act(async () => {
      await pending;
    });

    await waitFor(() => {
      expect(
        incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.archivedAt,
      ).toBe(5);
    });

    deliverStaleViewerList(incoming);
    await waitForStaleListApplied(incoming);
    expect(
      incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.archivedAt,
    ).toBe(5);
  });

  it("does not overwrite a present replacement row that belongs to another host", async () => {
    seedRemoteChat();
    let resolveRemote: (value: unknown) => void = () => {
      throw new Error("remote archive resolver is unavailable");
    };
    fixture.holdRemoteArchive = new Promise((resolve) => {
      resolveRemote = resolve;
    });
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

    const incoming = fixture.replaceMountedOnto(OTHER.hostId);
    incoming.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: record({
        chatId: REMOTE_CHAT_ID,
        originHostId: OTHER.hostId,
        title: "Other-host same id",
        origin: "own",
      }),
    });
    await waitFor(() => {
      expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.hostId).toBe(
        OTHER.hostId,
      );
    });

    resolveRemote(undefined);
    await act(async () => {
      await pending;
    });

    expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.title).toBe(
      "Other-host same id",
    );
    expect(
      incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.archivedAt,
    ).toBeNull();
  });

  it("deletes onto an empty replacement and keeps the identity tombstone through a stale viewer list", async () => {
    seedRemoteChat();
    let resolveRemote: (value: unknown) => void = () => {
      throw new Error("remote delete resolver is unavailable");
    };
    fixture.holdRemoteDelete = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const invalidateQueries = vi.spyOn(
      fixture.queryClient,
      "invalidateQueries",
    );
    const { result } = renderHook(() => useEpicDeleteChat(), {
      wrapper: fixture.wrapper,
    });

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
      });
    });

    const incoming = fixture.replaceMountedOnto(OTHER.hostId);
    expect(incoming.store.getState().snapshotLoaded).toBe(true);
    expect(incoming.store.getState().chats.allIds).toEqual([]);

    resolveRemote(undefined);
    await act(async () => {
      await pending;
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(OTHER.hostId, "epic.listChatRecords"),
    });

    deliverStaleViewerList(incoming);
    await waitForStaleListApplied(incoming);
    expect(
      Object.hasOwn(incoming.store.getState().chats.byId, REMOTE_CHAT_ID),
    ).toBe(false);
    expect(incoming.store.getState().chatRetractions).toEqual({});

    incoming.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: record({
        chatId: REMOTE_CHAT_ID,
        originHostId: OTHER.hostId,
        title: "Same-id other host",
        origin: "own",
      }),
    });
    await waitFor(() => {
      expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.hostId).toBe(
        OTHER.hostId,
      );
    });
    expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.title).toBe(
      "Same-id other host",
    );
    expect(incoming.store.getState().chatRetractions).toEqual({});
  });

  it("does not retract a present replacement row that belongs to another host", async () => {
    seedRemoteChat();
    let resolveRemote: (value: unknown) => void = () => {
      throw new Error("remote delete resolver is unavailable");
    };
    fixture.holdRemoteDelete = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    const { result } = renderHook(() => useEpicDeleteChat(), {
      wrapper: fixture.wrapper,
    });

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        hostId: REMOTE.hostId,
      });
    });

    const incoming = fixture.replaceMountedOnto(OTHER.hostId);
    incoming.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: record({
        chatId: REMOTE_CHAT_ID,
        originHostId: OTHER.hostId,
        title: "Other-host same id",
        origin: "own",
      }),
    });
    await waitFor(() => {
      expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.hostId).toBe(
        OTHER.hostId,
      );
    });

    resolveRemote(undefined);
    await act(async () => {
      await pending;
    });

    deliverStaleTargetHostList(incoming);
    await waitForStaleListApplied(incoming);
    expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.hostId).toBe(
      OTHER.hostId,
    );
    expect(incoming.store.getState().chats.byId[REMOTE_CHAT_ID]?.title).toBe(
      "Other-host same id",
    );
    expect(incoming.store.getState().chatRetractions).toEqual({});
  });
});

// Codex threads on d74e2198 (4303240629, 4303240636, 4303240645,
// 4303240648) and on 318466c2, and the round-7 cold review: one class - a
// step after a write keyed to the row's host instead of the host that
// enacted the write. Each write below is routed by a row naming REMOTE, which
// is down; OTHER stands in. Every step's refreshes are observed on keys
// seeded fresh before it, so no step is credited with another's.
describe("a write enacted by a stand-in", () => {
  const TUI_ID = "tui-moved";
  const TASK_ID = "task-moved";
  const SETTINGS: ChatRunSettings = {
    ultracode: false,
    harnessId: "codex",
    model: "gpt-5-codex",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };

  beforeEach(() => {
    standIn.answer = "applied";
    standIn.batchDeleteCalls.length = 0;
    standIn.tuiAgents.clear();
    standIn.tuiAgents.add(TUI_ID);
    standIn.tasks.clear();
    standIn.tasks.add(TASK_ID);
    standIn.holdTuiDelete = null;
    vi.mocked(toast.success).mockClear();
    useCloudChatDeletions.setState({
      pending: new Map(),
      confirmed: new Set(),
    });
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
      deletedEpicIdsByScope: {},
    });
    useComposerRunSettingsStore.getState().resetForTests();
    // The owner the rows name is down, and so is the viewing session's
    // host (the active host); OTHER is live and can write another host's
    // record.
    useSelectionAuthorityStore.setState({
      attached: true,
      leases: [
        { hostId: LOCAL.hostId, status: "dead", dead: { reason: "offline" } },
        { hostId: REMOTE.hostId, status: "dead", dead: { reason: "offline" } },
        { hostId: OTHER.hostId, status: "ready", dead: null },
      ],
    });
    recordNegotiatedHostManifest(OTHER.hostId, {
      "epic.setChatArchived": { major: 1, minor: 1, supportedMajors: [1] },
      "epic.deleteChat": { major: 1, minor: 2, supportedMajors: [1] },
      "epic.deleteTuiAgent": { major: 1, minor: 1, supportedMajors: [1] },
    });
    fixture.otherRecords.push(
      record({
        chatId: REMOTE_CHAT_ID,
        originHostId: OTHER.hostId,
        title: "Moved to the stand-in",
        origin: "own",
      }),
    );
  });

  afterEach(() => {
    useSelectionAuthorityStore.getState().reset();
    resetNegotiatedManifests();
    useComposerRunSettingsStore.getState().resetForTests();
    vi.restoreAllMocks();
  });

  /**
   * Seeds every list a write could refresh, per host, on a cleared cache, and
   * returns a reader of the ones invalidated since.
   */
  function observeRefreshes(): () => string[] {
    fixture.queryClient.clear();
    const keys = new Map<string, readonly unknown[]>();
    for (const { hostId } of DIRECTORY) {
      keys.set(`${hostId} chats`, [
        ...hostQueryKeys.methodScope(hostId, "epic.listChatRecords"),
        { epicId: EPIC_ID },
      ]);
      keys.set(`${hostId} terminal agents`, [
        ...hostQueryKeys.methodScope(hostId, "epic.listTuiAgents"),
        { epicId: EPIC_ID },
      ]);
      keys.set(
        `${hostId} cloud chats`,
        cloudChatListQueryKey({
          hostId,
          viewerUserId: VIEWER_ID,
          taskId: EPIC_ID,
        }),
      );
      keys.set(`${hostId} host scope`, [
        ...hostQueryKeys.scope(hostId),
        "probe",
      ]);
    }
    for (const key of keys.values()) {
      fixture.queryClient.setQueryData(key, { seeded: true });
    }
    return () =>
      [...keys].flatMap(([name, key]) =>
        fixture.queryClient.getQueryState(key)?.isInvalidated === true
          ? [name]
          : [],
      );
  }

  function confirmedDeletionOwners(): unknown[] {
    return [...useCloudChatDeletions.getState().confirmed].map((key) => {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) ? String(parsed[2]) : null;
    });
  }

  function successToasts(): unknown[] {
    return vi.mocked(toast.success).mock.calls.map((call) => call[0]);
  }

  /**
   * A list as OTHER serves it from what it holds, read into the cache before
   * the write, and a re-read that refetches it only if the write refreshed
   * it - so a refresh shows as the list after the commit.
   */
  async function readStandInList(
    queryKey: readonly unknown[],
    held: ReadonlySet<string>,
  ): Promise<() => Promise<unknown>> {
    await fixture.queryClient.fetchQuery({
      queryKey,
      queryFn: () => [...held],
    });
    return async () => {
      if (fixture.queryClient.getQueryState(queryKey)?.isInvalidated) {
        await fixture.queryClient.refetchQueries({ queryKey, exact: true });
      }
      return fixture.queryClient.getQueryData(queryKey);
    };
  }

  const otherTuiAgentList = [
    ...hostQueryKeys.methodScope(OTHER.hostId, "epic.listTuiAgents"),
    { epicId: EPIC_ID },
  ];
  const otherTaskList = [...hostQueryKeys.scope(OTHER.hostId), "tasks"];

  /** Each lifecycle mutation, mounted once and driven by the steps below. */
  function mountWrites() {
    const archive = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });
    const archiveMany = renderHook(() => useEpicArchiveChats(), {
      wrapper: fixture.wrapper,
    });
    const deleteChat = renderHook(() => useEpicDeleteChat(), {
      wrapper: fixture.wrapper,
    });
    const deleteTuiAgent = renderHook(() => useEpicDeleteTuiAgent(), {
      wrapper: fixture.wrapper,
    });
    const deleteTasks = renderHook(() => useEpicBatchDelete(), {
      wrapper: fixture.wrapper,
    });
    const settle = async (run: () => Promise<unknown>): Promise<void> => {
      await act(async () => {
        await run().catch(() => undefined);
      });
    };
    return {
      archive: (archived: boolean) =>
        settle(() =>
          archive.result.current.mutateAsync({
            epicId: EPIC_ID,
            chatId: REMOTE_CHAT_ID,
            hostId: REMOTE.hostId,
            archived,
          }),
        ),
      archiveMany: () =>
        settle(() =>
          archiveMany.result.current.mutateAsync({
            epicId: EPIC_ID,
            archived: true,
            chats: [
              {
                chatId: REMOTE_CHAT_ID,
                hostId: REMOTE.hostId,
                selectedRows: 1,
                coveredRows: () => 1,
              },
            ],
          }),
        ),
      deleteChat: () =>
        settle(() =>
          deleteChat.result.current.mutateAsync({
            epicId: EPIC_ID,
            chatId: REMOTE_CHAT_ID,
            hostId: REMOTE.hostId,
          }),
        ),
      deleteTuiAgent: () =>
        settle(() =>
          deleteTuiAgent.result.current.mutateAsync({
            epicId: EPIC_ID,
            tuiAgentId: TUI_ID,
            hostId: REMOTE.hostId,
          }),
        ),
      /**
       * The terminal-agent delete held at OTHER while the visible session is
       * replaced onto MOVED, whose list is read before the delete commits.
       */
      deleteTuiAgentAcrossReplacement: async (): Promise<void> => {
        let release: () => void = () => {
          throw new Error("the held delete has no release");
        };
        standIn.holdTuiDelete = new Promise((resolve) => {
          release = resolve;
        });
        let pending: Promise<unknown> = Promise.resolve();
        act(() => {
          pending = deleteTuiAgent.result.current
            .mutateAsync({
              epicId: EPIC_ID,
              tuiAgentId: TUI_ID,
              hostId: REMOTE.hostId,
            })
            .catch(() => undefined);
        });
        fixture.replaceMountedOnto(MOVED.hostId);
        release();
        await act(async () => {
          await pending;
        });
        standIn.holdTuiDelete = null;
      },
      deleteTasks: () =>
        settle(() =>
          deleteTasks.result.current.mutateAsync({
            ids: [TASK_ID],
            isLocalHomedNow: () => false,
            boundUserId: fixture.localClient.getRequestContextUserId(),
            worktreeCleanup: null,
          }),
        ),
    };
  }

  function spyCleanup() {
    const forceRelease = vi.spyOn(getChatSessionRegistry(), "forceRelease");
    const accessLoss = vi.spyOn(tabCommandCoordinator, "handleEpicAccessLoss");
    const closeTiles = vi.fn();
    const original =
      useEpicCanvasStore.getState().closeConfirmedDeletedAgentTiles;
    useEpicCanvasStore.setState({
      closeConfirmedDeletedAgentTiles: closeTiles,
    });
    return {
      forceRelease,
      accessLoss,
      closeTiles,
      restore: () => {
        useEpicCanvasStore.setState({
          closeConfirmedDeletedAgentTiles: original,
        });
      },
    };
  }

  /** A stale list still carrying `hostId`'s copy of the deleted chat. */
  async function deliverStaleCopyFrom(hostId: string): Promise<void> {
    deliverStaleList(fixture.handle, [
      record({
        chatId: REMOTE_CHAT_ID,
        originHostId: hostId,
        origin: "foreign",
      }),
      record({
        chatId: STALE_LIST_SENTINEL_ID,
        originHostId: LOCAL.hostId,
        origin: "foreign",
      }),
    ]);
    await waitForStaleListApplied(fixture.handle);
  }

  it("`applied`: every step follows the stand-in that owned the record", async () => {
    const writes = mountWrites();
    const spies = spyCleanup();
    try {
      // Archive: read back from the stand-in and matched to its record (the
      // viewer holds no row yet, so the read-back is what shows it).
      let refreshed = observeRefreshes();
      await writes.archive(true);
      expect(fixture.archiveCalls.map((call) => call.hostId)).toEqual([
        OTHER.hostId,
      ]);
      await waitFor(() => {
        expect(
          fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID]?.title,
        ).toBe("Moved to the stand-in");
      });
      expect(
        fixture.handle.store.getState().chats.byId[REMOTE_CHAT_ID]?.hostId,
      ).toBe(OTHER.hostId);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${OTHER.hostId} chats`,
          `${OTHER.hostId} terminal agents`,
        ]),
      );

      refreshed = observeRefreshes();
      await writes.archive(false);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${OTHER.hostId} chats`,
          `${OTHER.hostId} terminal agents`,
        ]),
      );

      refreshed = observeRefreshes();
      await writes.archiveMany();
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${OTHER.hostId} chats`,
          `${OTHER.hostId} terminal agents`,
        ]),
      );
      expect(fixture.archiveCalls.map((call) => call.hostId)).toEqual([
        OTHER.hostId,
        OTHER.hostId,
        OTHER.hostId,
      ]);

      // Chat delete: suppression, release, tile close and the confirmed
      // removal are the stand-in's chat.
      refreshed = observeRefreshes();
      await writes.deleteChat();
      expect(fixture.deleteCalls.map((call) => call.hostId)).toEqual([
        OTHER.hostId,
      ]);
      expect(confirmedDeletionOwners()).toEqual([OTHER.hostId]);
      expect(spies.forceRelease.mock.calls).toEqual([
        [EPIC_ID, REMOTE_CHAT_ID, OTHER.hostId],
      ]);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${OTHER.hostId} chats`,
          `${OTHER.hostId} cloud chats`,
        ]),
      );
      await deliverStaleCopyFrom(OTHER.hostId);
      expect(
        Object.hasOwn(
          fixture.handle.store.getState().chats.byId,
          REMOTE_CHAT_ID,
        ),
      ).toBe(false);

      // Terminal-agent delete, held while the visible session is replaced
      // onto MOVED, whose list was read before the delete committed.
      refreshed = observeRefreshes();
      await writes.deleteTuiAgentAcrossReplacement();
      expect(standIn.tuiAgents.has(TUI_ID)).toBe(false);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${OTHER.hostId} terminal agents`,
          `${MOVED.hostId} terminal agents`,
        ]),
      );
      expect(spies.closeTiles.mock.calls).toEqual([
        [EPIC_ID, REMOTE_CHAT_ID, OTHER.hostId, "chat"],
        [EPIC_ID, TUI_ID, OTHER.hostId, "terminal-agent"],
      ]);

      // Task delete: OTHER deleted ITS local-homed copy. This window holds
      // the Task on the active host, where it still exists: its tabs and
      // that host's settings stay, and only OTHER's scope is tombstoned.
      const runSettings = useComposerRunSettingsStore.getState();
      runSettings.setEpicRunSettings(TASK_ID, LOCAL.hostId, SETTINGS, 1);
      runSettings.setEpicRunSettings(TASK_ID, OTHER.hostId, SETTINGS, 1);
      refreshed = observeRefreshes();
      await writes.deleteTasks();
      expect(standIn.batchDeleteCalls).toEqual([OTHER.hostId]);
      const userId = fixture.localClient.getRequestContextUserId() ?? "";
      expect([
        ...deletedCloudEpicTasksPageEpicIdsForScope(OTHER.hostId, userId),
      ]).toEqual([TASK_ID]);
      expect([
        ...deletedCloudEpicTasksPageEpicIdsForScope(LOCAL.hostId, userId),
      ]).toEqual([]);
      expect(spies.accessLoss).not.toHaveBeenCalledWith(
        expect.arrayContaining([TASK_ID]),
      );
      expect(
        useComposerRunSettingsStore
          .getState()
          .getEpicRunSettings(TASK_ID, LOCAL.hostId),
      ).toEqual(SETTINGS);
      expect(
        useComposerRunSettingsStore
          .getState()
          .getEpicRunSettings(TASK_ID, OTHER.hostId),
      ).toBeNull();
      expect(refreshed()).toEqual(
        expect.arrayContaining([`${OTHER.hostId} host scope`]),
      );
    } finally {
      spies.restore();
    }
  });

  it("`requested`: every step follows the owner the stand-in names", async () => {
    standIn.answer = "requested";
    const writes = mountWrites();
    const spies = spyCleanup();
    try {
      let refreshed = observeRefreshes();
      await writes.archive(true);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${MOVED.hostId} chats`,
          `${MOVED.hostId} terminal agents`,
        ]),
      );

      refreshed = observeRefreshes();
      await writes.archive(false);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${MOVED.hostId} chats`,
          `${MOVED.hostId} terminal agents`,
        ]),
      );

      refreshed = observeRefreshes();
      await writes.archiveMany();
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${MOVED.hostId} chats`,
          `${MOVED.hostId} terminal agents`,
        ]),
      );

      refreshed = observeRefreshes();
      await writes.deleteChat();
      expect(confirmedDeletionOwners()).toEqual([MOVED.hostId]);
      expect(spies.forceRelease.mock.calls).toEqual([
        [EPIC_ID, REMOTE_CHAT_ID, MOVED.hostId],
      ]);
      expect(refreshed()).toEqual(
        expect.arrayContaining([
          `${MOVED.hostId} chats`,
          `${MOVED.hostId} cloud chats`,
        ]),
      );
      // The confirmed removal is the named owner's chat.
      await deliverStaleCopyFrom(MOVED.hostId);
      expect(
        Object.hasOwn(
          fixture.handle.store.getState().chats.byId,
          REMOTE_CHAT_ID,
        ),
      ).toBe(false);

      refreshed = observeRefreshes();
      await writes.deleteTuiAgent();
      expect(refreshed()).toEqual(
        expect.arrayContaining([`${MOVED.hostId} terminal agents`]),
      );
      expect(spies.closeTiles.mock.calls).toEqual([
        [EPIC_ID, REMOTE_CHAT_ID, MOVED.hostId, "chat"],
        [EPIC_ID, TUI_ID, MOVED.hostId, "terminal-agent"],
      ]);
      // The requested notices name the owner the stand-in reports.
      expect(successToasts()).toEqual(
        expect.arrayContaining([
          "Archived. Moved Host will finish when it is back",
          "Unarchived. Moved Host will finish when it is back",
          "Removed. Files on Moved Host are untouched",
          "Removed. The agent may keep running on Moved Host until that host reconnects. Its files are untouched",
        ]),
      );
      expect(
        successToasts().filter(
          (message) =>
            typeof message === "string" && message.includes("Mock Remote"),
        ),
      ).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  it("an answer lost after the write: each write refreshes every list it could have changed", async () => {
    standIn.answer = "lost";
    const writes = mountWrites();

    let refreshed = observeRefreshes();
    await writes.archive(true);
    expect(refreshed()).toEqual(
      expect.arrayContaining([
        `${OTHER.hostId} chats`,
        `${OTHER.hostId} terminal agents`,
      ]),
    );

    refreshed = observeRefreshes();
    await writes.archive(false);
    expect(refreshed()).toEqual(
      expect.arrayContaining([
        `${OTHER.hostId} chats`,
        `${OTHER.hostId} terminal agents`,
      ]),
    );

    refreshed = observeRefreshes();
    const notices = [toast.error, toast.message, toast.warning, toast.success];
    for (const notice of notices) vi.mocked(notice).mockClear();
    await writes.archiveMany();
    expect(refreshed()).toEqual(
      expect.arrayContaining([
        `${OTHER.hostId} chats`,
        `${OTHER.hostId} terminal agents`,
      ]),
    );
    // The row's failure is reported once, by the batch, not by the row too.
    expect(
      notices.reduce(
        (count, notice) => count + vi.mocked(notice).mock.calls.length,
        0,
      ),
    ).toBe(1);

    refreshed = observeRefreshes();
    await writes.deleteChat();
    expect(refreshed()).toEqual(
      expect.arrayContaining([
        `${OTHER.hostId} chats`,
        `${OTHER.hostId} cloud chats`,
      ]),
    );
    // The provisional hide is released.
    expect(useCloudChatDeletions.getState().confirmed.size).toBe(0);
    expect(useCloudChatDeletions.getState().pending.size).toBe(0);

    // The terminal-agent delete commits on OTHER, then its answer is lost,
    // while the visible session is replaced onto MOVED.
    refreshed = observeRefreshes();
    let reread = await readStandInList(otherTuiAgentList, standIn.tuiAgents);
    await writes.deleteTuiAgentAcrossReplacement();
    expect(refreshed()).toEqual(
      expect.arrayContaining([
        `${OTHER.hostId} terminal agents`,
        `${MOVED.hostId} terminal agents`,
      ]),
    );
    expect(await reread()).toEqual([]);

    // The purge commits on OTHER, then its answer is lost.
    refreshed = observeRefreshes();
    reread = await readStandInList(otherTaskList, standIn.tasks);
    await writes.deleteTasks();
    expect(standIn.batchDeleteCalls).toEqual([OTHER.hostId]);
    expect(refreshed()).toEqual(
      expect.arrayContaining([
        `${OTHER.hostId} host scope`,
        `${LOCAL.hostId} host scope`,
      ]),
    );
    expect(await reread()).toEqual([]);
  });
});
