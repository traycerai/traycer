/**
 * `useEpicRenameChat` / `useEpicRenameTuiAgent` / `useEpicDeleteTuiAgent` must
 * address the record's owning host, not the viewing epic session: same-host
 * dispatches through the session client and strips `hostId` from the wire, a
 * remote row routes to its true owner and never writes another host's
 * same-id row, and a `null`/unreachable host rejects without dispatching.
 *
 * Drives the real hooks against a real `HostClient` over `MockHostMessenger`
 * and a real `QueryClient`. The chat suite also drives a real open-epic store
 * and `useEpicSyncChatRecords` to prove the remote row is reachable through
 * this epic's own list projection before it is renamed. Terminal-agent
 * rename/delete never read that store, so those suites assert directly on
 * the fixture's per-host record arrays.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  DeleteTuiAgentRequest,
  RenameChatRequest,
  RenameTuiAgentRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicRenameChat } from "@/hooks/epic/use-epic-chat-mutations";
import {
  useEpicDeleteTuiAgent,
  useEpicRenameTuiAgent,
} from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicSyncChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { resolveChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
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
  toast: { error: vi.fn(), success: vi.fn() },
}));

const LOCAL = mockLocalHostEntry;
const REMOTE = mockRemoteHostEntry;
const DIRECTORY: readonly HostDirectoryEntry[] = [LOCAL, REMOTE];
const EPIC_ID = "epic-rename-delete-routing";
const VIEWER_ID = "viewer-rename-delete";
const REMOTE_CHAT_ID = "chat-remote";
const LOCAL_CHAT_ID = "chat-local";
const REMOTE_TUI_ID = "tui-remote";
const LOCAL_TUI_ID = "tui-local";

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

interface TuiAgentFixtureRow {
  tuiAgentId: string;
  title: string;
}

interface RoutingFixture {
  readonly queryClient: QueryClient;
  readonly handle: OpenedStoreForTest;
  readonly localRecords: ChatRecordSummaryV11[];
  readonly remoteRecords: ChatRecordSummaryV11[];
  readonly viewerForeign: ChatRecordSummaryV11[];
  readonly localTuiAgents: TuiAgentFixtureRow[];
  readonly remoteTuiAgents: TuiAgentFixtureRow[];
  readonly renameChatCalls: MutationCall[];
  readonly renameTuiCalls: MutationCall[];
  readonly deleteTuiCalls: MutationCall[];
  readonly listCallsByHost: Record<string, number>;
  /**
   * Held open until resolved, so a test can unmount its `renderHook` while
   * the delete is still in flight - proving the hook-level `onSuccess`
   * (unlike a per-call one) survives that unmount.
   */
  holdDeleteTuiAgent: Promise<unknown> | null;
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
      title: "Epic rename/delete routing",
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
  const localTuiAgents: TuiAgentFixtureRow[] = [];
  const remoteTuiAgents: TuiAgentFixtureRow[] = [];
  const renameChatCalls: MutationCall[] = [];
  const renameTuiCalls: MutationCall[] = [];
  const deleteTuiCalls: MutationCall[] = [];
  const listCallsByHost: Record<string, number> = {};
  const mutable: { holdDeleteTuiAgent: Promise<unknown> | null } = {
    holdDeleteTuiAgent: null,
  };

  const requestSeq = { value: 0 };
  const messengerRef: { current: MockHostMessenger<HostRpcRegistry> | null } = {
    current: null,
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq.value += 1;
      return `rename-delete-${String(requestSeq.value)}`;
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
          return {
            kind: "snapshot" as const,
            listStamp: null,
            chats: remoteRecords.map((row) => ({ ...row })),
          };
        }
        return { kind: "snapshot" as const, listStamp: null, chats: [] };
      },
      // `ChatRegistryWriter.commitMetadata` returns early on an absent row
      // rather than failing the call, and `epic.renameChat`'s resolver still
      // answers `updated: true` - a missing row is a no-op, not an error.
      "epic.renameChat": (request: RenameChatRequest) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        renameChatCalls.push({ hostId, params: request });
        const target =
          hostId === REMOTE.hostId
            ? remoteRecords.find((row) => row.chatId === request.chatId)
            : localRecords.find((row) => row.chatId === request.chatId);
        if (target !== undefined) target.title = request.title;
        return { updated: true };
      },
      // The TUI resolver reports the miss instead: `updated: false` for an
      // absent row, still no-op, still no throw.
      "epic.renameTuiAgent": (request: RenameTuiAgentRequest) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        renameTuiCalls.push({ hostId, params: request });
        const pool =
          hostId === REMOTE.hostId ? remoteTuiAgents : localTuiAgents;
        const target = pool.find(
          (row) => row.tuiAgentId === request.tuiAgentId,
        );
        if (target === undefined) return { updated: false };
        target.title = request.title;
        return { updated: true };
      },
      "epic.deleteTuiAgent": (request: DeleteTuiAgentRequest) => {
        const hostId = lastCallHost(messengerRef.current ?? messenger);
        deleteTuiCalls.push({ hostId, params: request });
        const pool =
          hostId === REMOTE.hostId ? remoteTuiAgents : localTuiAgents;
        const index = pool.findIndex(
          (row) => row.tuiAgentId === request.tuiAgentId,
        );
        const respond = (): { deleted: boolean } => {
          if (index < 0) return { deleted: false };
          pool.splice(index, 1);
          return { deleted: true };
        };
        if (mutable.holdDeleteTuiAgent !== null) {
          return mutable.holdDeleteTuiAgent.then(respond);
        }
        return respond();
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
      bearerToken: "rename-delete-routing-token",
    }),
  );
  const localClient = spine.createRequester(LOCAL);
  spineRef.value = spine;
  const registry = __getOpenEpicRegistryForTests();
  registry.disposeAll();
  const handle = newSession();
  registry.acquireMounted(EPIC_ID, () => handle);

  // The session client is fixed for this suite's lifetime - no
  // host-swap-in-flight scenario here - so a plain `Provider` is enough.
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={handle}>
        <EpicSessionHostClientContext.Provider value={localClient}>
          {props.children}
        </EpicSessionHostClientContext.Provider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );

  const dispose = (): void => {
    registry.disposeAll();
    handle.store.getState().dispose();
    spine.dispose();
    spineRef.value = null;
  };

  return {
    queryClient,
    handle,
    localRecords,
    remoteRecords,
    viewerForeign,
    localTuiAgents,
    remoteTuiAgents,
    renameChatCalls,
    renameTuiCalls,
    deleteTuiCalls,
    listCallsByHost,
    get holdDeleteTuiAgent() {
      return mutable.holdDeleteTuiAgent;
    },
    set holdDeleteTuiAgent(value: Promise<unknown> | null) {
      mutable.holdDeleteTuiAgent = value;
    },
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
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
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
  fixture.viewerForeign.push({ ...remoteRow, origin: "foreign" });
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

describe("useEpicRenameChat routing", () => {
  it("dispatches a same-host rename through the session client and strips hostId", async () => {
    seedLocalChat();
    const { result } = renderHook(() => useEpicRenameChat(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: LOCAL_CHAT_ID,
        title: "Renamed locally",
        hostId: LOCAL.hostId,
      });
    });

    expect(fixture.renameChatCalls).toEqual([
      {
        hostId: LOCAL.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: LOCAL_CHAT_ID,
          title: "Renamed locally",
        },
      },
    ]);
    expect(fixture.localRecords[0]?.title).toBe("Renamed locally");
  });

  it("renames a remote chat on the owning host, not the viewing session, and refreshes both list caches", async () => {
    // The remote row is reachable through THIS epic's own list projection
    // before the rename - not a fixture-only fact, but a row the session
    // actually surfaces as a foreign replica.
    seedRemoteChat();
    const invalidateQueries = vi.spyOn(
      fixture.queryClient,
      "invalidateQueries",
    );
    const { result } = renderHook(
      () => {
        useEpicSyncChatRecords(EPIC_ID);
        return useEpicRenameChat();
      },
      { wrapper: fixture.wrapper },
    );
    await settleViewerList();
    const chatsById = fixture.handle.store.getState().chats.byId;
    expect(Object.hasOwn(chatsById, REMOTE_CHAT_ID)).toBe(true);
    const projectedRow = chatsById[REMOTE_CHAT_ID];
    expect(projectedRow.hostId).toBe(REMOTE.hostId);
    expect(projectedRow.docResident).toBe(false);
    // The real caller-facing gate agrees this row is registry-addressable
    // from the viewing (LOCAL) session - the scenario below is not just
    // routable, it is one a real rename affordance would actually send.
    expect(
      resolveChatWriteRoute({
        chatsById,
        isChatRow: true,
        nodeId: REMOTE_CHAT_ID,
        sessionHostId: LOCAL.hostId,
      }),
    ).toBe("registry-rpc");

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        title: "Renamed remotely",
        hostId: REMOTE.hostId,
      });
    });

    expect(fixture.renameChatCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: {
          epicId: EPIC_ID,
          chatId: REMOTE_CHAT_ID,
          title: "Renamed remotely",
        },
      },
    ]);
    expect(fixture.remoteRecords[0]?.title).toBe("Renamed remotely");
    // The viewing host's own replica was never written to.
    expect(fixture.localRecords).toEqual([]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(
        REMOTE.hostId,
        "epic.listChatRecords",
      ),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(LOCAL.hostId, "epic.listChatRecords"),
    });
  });

  it("fails closed for a null host without dispatching anywhere", async () => {
    const { result } = renderHook(() => useEpicRenameChat(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        title: "Should not land",
        hostId: null,
      }),
    ).rejects.toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-unavailable",
      method: "epic.renameChat",
    });
    expect(fixture.renameChatCalls).toEqual([]);
  });

  it("does not fall back to the session host when the named host is unavailable", async () => {
    const { result } = renderHook(() => useEpicRenameChat(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        chatId: REMOTE_CHAT_ID,
        title: "Should not land",
        hostId: "host-missing",
      }),
    ).rejects.toBeTruthy();
    expect(fixture.renameChatCalls).toEqual([]);
  });
});

function seedRemoteTuiAgent(): void {
  fixture.remoteTuiAgents.push({
    tuiAgentId: REMOTE_TUI_ID,
    title: "Remote terminal",
  });
}

function seedLocalTuiAgent(): void {
  fixture.localTuiAgents.push({
    tuiAgentId: LOCAL_TUI_ID,
    title: "Local terminal",
  });
}

describe("useEpicRenameTuiAgent routing", () => {
  it("dispatches a same-host rename through the session client and strips hostId", async () => {
    seedLocalTuiAgent();
    const { result } = renderHook(() => useEpicRenameTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: LOCAL_TUI_ID,
        title: "Renamed local terminal",
        hostId: LOCAL.hostId,
      });
    });

    expect(fixture.renameTuiCalls).toEqual([
      {
        hostId: LOCAL.hostId,
        params: {
          epicId: EPIC_ID,
          tuiAgentId: LOCAL_TUI_ID,
          title: "Renamed local terminal",
        },
      },
    ]);
    expect(fixture.localTuiAgents[0]?.title).toBe("Renamed local terminal");
  });

  it("renames a remote terminal agent on the owning host, not the viewing session, and refreshes both list caches", async () => {
    seedRemoteTuiAgent();
    const invalidateQueries = vi.spyOn(
      fixture.queryClient,
      "invalidateQueries",
    );
    const { result } = renderHook(() => useEpicRenameTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: REMOTE_TUI_ID,
        title: "Renamed remote terminal",
        hostId: REMOTE.hostId,
      });
    });

    expect(fixture.renameTuiCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: {
          epicId: EPIC_ID,
          tuiAgentId: REMOTE_TUI_ID,
          title: "Renamed remote terminal",
        },
      },
    ]);
    expect(fixture.remoteTuiAgents[0]?.title).toBe("Renamed remote terminal");
    // Nothing was ever sent to the session/local host for this row.
    expect(fixture.localTuiAgents).toEqual([]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(REMOTE.hostId, "epic.listTuiAgents"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(LOCAL.hostId, "epic.listTuiAgents"),
    });
  });

  it("fails closed for a null host without dispatching anywhere", async () => {
    const { result } = renderHook(() => useEpicRenameTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: REMOTE_TUI_ID,
        title: "Should not land",
        hostId: null,
      }),
    ).rejects.toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-unavailable",
      method: "epic.renameTuiAgent",
    });
    expect(fixture.renameTuiCalls).toEqual([]);
  });
});

describe("useEpicDeleteTuiAgent routing", () => {
  it("dispatches a same-host delete through the session client", async () => {
    seedLocalTuiAgent();
    const { result } = renderHook(() => useEpicDeleteTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: LOCAL_TUI_ID,
        hostId: LOCAL.hostId,
      });
    });

    expect(fixture.deleteTuiCalls).toEqual([
      {
        hostId: LOCAL.hostId,
        params: { epicId: EPIC_ID, tuiAgentId: LOCAL_TUI_ID },
      },
    ]);
    expect(fixture.localTuiAgents).toEqual([]);
  });

  it("deletes a remote terminal agent on the owning host and never touches a same-id row on another host", async () => {
    // Two hosts each hold a row under the SAME id - the sharpest version of
    // "wrong machine": a same-host fallback here would delete the WRONG
    // agent instead of merely missing the right one.
    seedRemoteTuiAgent();
    fixture.localTuiAgents.push({
      tuiAgentId: REMOTE_TUI_ID,
      title: "Unrelated local agent, same id",
    });
    const invalidateQueries = vi.spyOn(
      fixture.queryClient,
      "invalidateQueries",
    );
    const { result } = renderHook(() => useEpicDeleteTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: REMOTE_TUI_ID,
        hostId: REMOTE.hostId,
      });
    });

    expect(fixture.deleteTuiCalls).toEqual([
      {
        hostId: REMOTE.hostId,
        params: { epicId: EPIC_ID, tuiAgentId: REMOTE_TUI_ID },
      },
    ]);
    expect(fixture.remoteTuiAgents).toEqual([]);
    expect(fixture.localTuiAgents).toEqual([
      { tuiAgentId: REMOTE_TUI_ID, title: "Unrelated local agent, same id" },
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(REMOTE.hostId, "epic.listTuiAgents"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(LOCAL.hostId, "epic.listTuiAgents"),
    });
  });

  it("fails closed for a null host without dispatching anywhere", async () => {
    const { result } = renderHook(() => useEpicDeleteTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: REMOTE_TUI_ID,
        hostId: null,
      }),
    ).rejects.toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-unavailable",
      method: "epic.deleteTuiAgent",
    });
    expect(fixture.deleteTuiCalls).toEqual([]);
  });

  it("does not fall back to the session host when the named host is unavailable", async () => {
    const { result } = renderHook(() => useEpicDeleteTuiAgent(), {
      wrapper: fixture.wrapper,
    });

    await expect(
      result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: REMOTE_TUI_ID,
        hostId: "host-missing",
      }),
    ).rejects.toBeTruthy();
    expect(fixture.deleteTuiCalls).toEqual([]);
  });

  it("retires every owning-host tile and closed payload after unmount, preserving the peer host's", async () => {
    // Pre-existing closed-tile payloads, from an unrelated EARLIER close -
    // not produced by this delete, so a sweep that only ran because a
    // mounted caller's per-call `onSuccess` fired would miss them. Proves the
    // cleanup is the HOOK's own `onSuccess` (survives unmount), not the
    // per-call one TanStack drops when the observer is torn down first.
    seedRemoteTuiAgent();
    const canvasTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Tab");
    const seedClosedPayload = (hostId: string, instanceId: string): void => {
      useEpicCanvasStore.getState().openTileInTab(canvasTabId, {
        id: REMOTE_TUI_ID,
        instanceId,
        type: "terminal-agent",
        name: "Shared terminal agent",
        hostId,
      });
      const canvas = useEpicCanvasStore.getState().canvasByTabId[canvasTabId];
      if (canvas === undefined) throw new Error("expected a canvas");
      const paneId = collectPanes(canvas.root).at(0)?.id;
      if (paneId === undefined) throw new Error("expected a pane");
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(canvasTabId, paneId, instanceId);
    };
    seedClosedPayload(REMOTE.hostId, "inst-remote-closed");
    seedClosedPayload(LOCAL.hostId, "inst-local-closed");

    // LIVE tiles for the deleted row (REMOTE.hostId), spread across two view
    // tabs and, within the first, two separate panes - the sweep must not be
    // scoped to whichever single tab/pane a caller happened to look in. A
    // same-id LOCAL.hostId peer, live alongside them, must survive.
    useEpicCanvasStore.getState().openTileInTab(canvasTabId, {
      id: REMOTE_TUI_ID,
      instanceId: "inst-b-live-1",
      type: "terminal-agent",
      name: "Shared terminal agent",
      hostId: REMOTE.hostId,
    });
    useEpicCanvasStore.getState().openTileInTab(canvasTabId, {
      id: REMOTE_TUI_ID,
      instanceId: "inst-a-live",
      type: "terminal-agent",
      name: "Peer terminal agent",
      hostId: LOCAL.hostId,
    });
    const canvasForSplit =
      useEpicCanvasStore.getState().canvasByTabId[canvasTabId];
    if (canvasForSplit === undefined) throw new Error("expected a canvas");
    const paneForSplit = collectPanes(canvasForSplit.root).at(0)?.id;
    if (paneForSplit === undefined) throw new Error("expected a pane");
    // `splitPaneWithNode` MOVES an existing same-id/host tile into the new
    // pane rather than opening a second instance - not what a genuinely
    // separate second live tile needs. `splitPaneEmptyInTab` makes the new
    // pane, then `openTileInPane` opens directly into it, bypassing dedup
    // (the same non-dedup path a second view of already-open content uses).
    const secondPaneId = useEpicCanvasStore
      .getState()
      .splitPaneEmptyInTab(canvasTabId, paneForSplit, "horizontal");
    if (secondPaneId === null) throw new Error("expected a new pane");
    useEpicCanvasStore.getState().openTileInPane(
      canvasTabId,
      secondPaneId,
      {
        id: REMOTE_TUI_ID,
        instanceId: "inst-b-live-2",
        type: "terminal-agent",
        name: "Shared terminal agent",
        hostId: REMOTE.hostId,
      },
      { mode: "permanent", index: null },
    );
    const secondViewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Tab 2");
    useEpicCanvasStore.getState().openTileInTab(secondViewTabId, {
      id: REMOTE_TUI_ID,
      instanceId: "inst-b-live-3",
      type: "terminal-agent",
      name: "Shared terminal agent",
      hostId: REMOTE.hostId,
    });

    function ownedInstanceIds(
      tabId: string,
      id: string,
      hostId: string,
    ): readonly string[] {
      const tiles =
        useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId ??
        {};
      return Object.entries(tiles)
        .filter(([, tile]) => tile?.id === id && tile.hostId === hostId)
        .map(([instanceId]) => instanceId);
    }

    // Preconditions: every instance this test claims to retire or preserve
    // genuinely exists, in genuinely separate tabs/panes, BEFORE the delete
    // runs - otherwise an instance that was never created would pass the
    // post-delete "is absent" assertions vacuously.
    expect(secondViewTabId).not.toBe(canvasTabId);
    const tab1BInstanceIds = ownedInstanceIds(
      canvasTabId,
      REMOTE_TUI_ID,
      REMOTE.hostId,
    );
    const tab2BInstanceIds = ownedInstanceIds(
      secondViewTabId,
      REMOTE_TUI_ID,
      REMOTE.hostId,
    );
    expect(tab1BInstanceIds).toHaveLength(2);
    expect(tab2BInstanceIds).toHaveLength(1);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[canvasTabId]
        ?.tilesByInstanceId["inst-a-live"],
    ).toBeDefined();
    const canvasBeforeDelete =
      useEpicCanvasStore.getState().canvasByTabId[canvasTabId];
    if (canvasBeforeDelete === undefined) throw new Error("expected a canvas");
    expect(collectPanes(canvasBeforeDelete.root).length).toBeGreaterThanOrEqual(
      2,
    );

    const { result, unmount } = renderHook(() => useEpicDeleteTuiAgent(), {
      wrapper: fixture.wrapper,
    });
    let resolveHold: (value: unknown) => void = () => {
      throw new Error("delete resolver is unavailable");
    };
    fixture.holdDeleteTuiAgent = new Promise((resolve) => {
      resolveHold = resolve;
    });

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.mutateAsync({
        epicId: EPIC_ID,
        tuiAgentId: REMOTE_TUI_ID,
        hostId: REMOTE.hostId,
      });
    });
    unmount();
    resolveHold(undefined);
    await act(async () => {
      await pending;
    });

    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[canvasTabId]?.[
        "inst-remote-closed"
      ],
    ).toBeUndefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[canvasTabId]?.[
        "inst-local-closed"
      ],
    ).toBeDefined();

    const tab1Tiles =
      useEpicCanvasStore.getState().canvasByTabId[canvasTabId]
        ?.tilesByInstanceId ?? {};
    const tab2Tiles =
      useEpicCanvasStore.getState().canvasByTabId[secondViewTabId]
        ?.tilesByInstanceId ?? {};
    for (const instanceId of tab1BInstanceIds) {
      expect(tab1Tiles[instanceId]).toBeUndefined();
    }
    for (const instanceId of tab2BInstanceIds) {
      expect(tab2Tiles[instanceId]).toBeUndefined();
    }
    expect(tab1Tiles["inst-a-live"]).toBeDefined();
  });
});
