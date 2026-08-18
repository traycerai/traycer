import { useMemo, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  GuiHarnessId,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  __getOpenEpicRegistryForTests,
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import {
  useEpicArtifactRecords,
  useEpicChatHarnessId,
  useEpicAgentRoleClaims,
  useEpicAgentRoleClaimsByAgentId,
  useEpicAgentReference,
  useEpicSyncPillState,
  useMaybeEpicTuiAgentHarnessId,
  useRegisteredEpicLiveArtifactTitles,
} from "@/lib/epic-selectors";

const featureSettings = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/runner/use-runner-feature-settings-query", () => ({
  useAgentRolesEnabled: () => featureSettings.enabled,
}));
// The app-wide addressable host, deliberately DIFFERENT from any session
// host below: the record fallback must never read it (Codex #1243 T-49).
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-addressable",
}));
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type {
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";

const handles: OpenEpicStoreHandle[] = [];

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  featureSettings.enabled = true;
  for (const handle of handles) {
    handle.dispose();
  }
  handles.length = 0;
});

describe("useRegisteredEpicLiveArtifactTitles", () => {
  it("subscribes when a registered handle initially has no title", () => {
    const registry = __getOpenEpicRegistryForTests();
    const { result } = renderHook(() =>
      useRegisteredEpicLiveArtifactTitles([
        { epicId: "epic-late-handle", artifactId: "chat-1" },
      ]),
    );
    expect(result.current).toEqual([null]);

    const handle = createOpenEpicStore({
      epicId: "epic-late-handle",
      userId: null,
      streamClientFactory: fakeStreamClientFactory,
      onAuthError: null,
    });
    handle.store.setState({
      chats: {
        allIds: ["chat-1"],
        byId: { "chat-1": { ...chat("chat-1", null), title: "" } },
      },
    });
    act(() => {
      registry.acquire("epic-late-handle", () => handle);
    });
    expect(result.current).toEqual([null]);

    act(() => {
      handle.store.setState({
        chats: {
          allIds: ["chat-1"],
          byId: {
            "chat-1": { ...chat("chat-1", null), title: "Generated title" },
          },
        },
      });
    });

    expect(result.current).toEqual(["Generated title"]);
  });

  it("subscribes to a late handle when the refs identity is stable", () => {
    const registry = __getOpenEpicRegistryForTests();
    const { result } = renderHook(() => {
      const refs = useMemo(
        () => [{ epicId: "epic-stable-refs", artifactId: "chat-1" }],
        [],
      );
      return useRegisteredEpicLiveArtifactTitles(refs);
    });
    expect(result.current).toEqual([null]);

    const handle = createOpenEpicStore({
      epicId: "epic-stable-refs",
      userId: null,
      streamClientFactory: fakeStreamClientFactory,
      onAuthError: null,
    });
    handle.store.setState({
      chats: {
        allIds: ["chat-1"],
        byId: { "chat-1": { ...chat("chat-1", null), title: "" } },
      },
    });
    act(() => {
      registry.acquire("epic-stable-refs", () => handle);
    });
    expect(result.current).toEqual([null]);

    act(() => {
      handle.store.setState({
        chats: {
          allIds: ["chat-1"],
          byId: {
            "chat-1": { ...chat("chat-1", null), title: "Stable refs title" },
          },
        },
      });
    });

    expect(result.current).toEqual(["Stable refs title"]);
  });
});

describe("useMaybeEpicTuiAgentHarnessId", () => {
  it("returns null outside an open-epic session", () => {
    const { result } = renderHook(() =>
      useMaybeEpicTuiAgentHarnessId("agent-1"),
    );

    expect(result.current).toBeNull();
  });

  it("returns null when no tuiAgents.byId entry matches the node id", () => {
    const handle = createHandle("epic-missing-agent");

    const { result } = renderHook(
      () => useMaybeEpicTuiAgentHarnessId("agent-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    expect(result.current).toBeNull();
  });

  it("returns the matching tuiAgents.byId harnessId", () => {
    const handle = createHandle("epic-with-agent");
    handle.store.setState({
      tuiAgents: {
        allIds: ["agent-1"],
        byId: {
          "agent-1": tuiAgent("agent-1", "codex"),
        },
      },
    });

    const { result } = renderHook(
      () => useMaybeEpicTuiAgentHarnessId("agent-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    expect(result.current).toBe("codex");
  });

  it("updates when tuiAgents.byId changes after mount", () => {
    const handle = createHandle("epic-live-update");

    const { result } = renderHook(
      () => useMaybeEpicTuiAgentHarnessId("agent-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    expect(result.current).toBeNull();

    act(() => {
      handle.store.setState({
        tuiAgents: {
          allIds: ["agent-1"],
          byId: {
            "agent-1": tuiAgent("agent-1", "codex"),
          },
        },
      });
    });

    expect(result.current).toBe("codex");
  });
});

describe("useEpicChatHarnessId", () => {
  it("tracks a GUI harness and missing legacy settings", () => {
    const handle = createHandle("epic-chat-harness");
    handle.store.setState({
      chats: {
        allIds: ["chat-1"],
        byId: {
          "chat-1": chat("chat-1", "claude"),
        },
      },
    });

    const { result } = renderHook(() => useEpicChatHarnessId("chat-1"), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("claude");

    act(() => {
      handle.store.setState({
        chats: {
          allIds: ["chat-1"],
          byId: {
            "chat-1": chat("chat-1", null),
          },
        },
      });
    });

    expect(result.current).toBeNull();
  });
});

describe("useEpicArtifactRecords", () => {
  it("stamps chat and artifact records with the SESSION handle's host, not the app-wide addressable one", () => {
    // During an A→B re-point the A-backed Epic stays rendered while the
    // addressable host already answers B; every record stamped here is copied
    // by its consumers (`AgentReferenceChip`, the route-focus opener) into a
    // tile ref bound for life. The fallback is the handle's own host.
    const handle = createHandle("epic-records-host");
    handleHostIds.set(handle, "host-session");
    handle.store.setState({
      chats: {
        allIds: ["chat-1"],
        byId: { "chat-1": chat("chat-1", "claude") },
      },
    });
    const { result } = renderHook(() => useEpicArtifactRecords(), {
      wrapper: openEpicWrapper(handle),
    });

    const record = result.current.find((row) => row.id === "chat-1");
    expect(record).toBeDefined();
    expect(record?.hostId).toBe("host-session");
  });
});

describe("useEpicAgentReference", () => {
  const chatId = "9600b202-1111-4111-8111-111111111111";
  const tuiAgentId = "beefcafe-2222-4222-8222-222222222222";

  function handleWithAgents(epicId: string): OpenEpicStoreHandle {
    const handle = createHandle(epicId);
    handle.store.setState({
      chats: {
        allIds: [chatId],
        byId: { [chatId]: chat(chatId, "claude") },
      },
      tuiAgents: {
        allIds: [tuiAgentId],
        byId: { [tuiAgentId]: tuiAgent(tuiAgentId, "codex") },
      },
    });
    return handle;
  }

  it("resolves exact ids and unique prefixes across chat and terminal agents", () => {
    const handle = handleWithAgents("epic-agent-reference");
    const { result, rerender } = renderHook(
      ({ referenceId }) => useEpicAgentReference(referenceId),
      {
        initialProps: { referenceId: chatId },
        wrapper: openEpicWrapper(handle),
      },
    );

    expect(result.current?.id).toBe(chatId);

    rerender({ referenceId: "9600b202" });
    expect(result.current?.id).toBe(chatId);

    rerender({ referenceId: "beef" });
    expect(result.current?.id).toBe(tuiAgentId);
  });

  it("rejects short, ambiguous, and role-claim prefixes", () => {
    const handle = handleWithAgents("epic-unresolved-agent-reference");
    const secondChatId = "9600b202-3333-4333-8333-333333333333";
    const roleClaimId = "feedface-4444-4444-8444-444444444444";
    handle.store.setState({
      chats: {
        allIds: [chatId, secondChatId],
        byId: {
          [chatId]: chat(chatId, "claude"),
          [secondChatId]: chat(secondChatId, "codex"),
        },
      },
      agentRoles: {
        byAgentId: {
          [chatId]: [
            {
              claimId: roleClaimId,
              agentId: chatId,
              userId: "user-1",
              role: "Reviewer",
              scope: "prefix tests",
              claimedAt: 1,
            },
          ],
        },
      },
    });

    const { result, rerender } = renderHook(
      ({ referenceId }) => useEpicAgentReference(referenceId),
      {
        initialProps: { referenceId: "960" },
        wrapper: openEpicWrapper(handle),
      },
    );

    expect(result.current).toBeNull();

    rerender({ referenceId: "9600b202" });
    expect(result.current).toBeNull();

    rerender({ referenceId: "feed" });
    expect(result.current).toBeNull();
  });
});

describe("useEpicSyncPillState", () => {
  function healthyBaseline(handle: OpenEpicStoreHandle): void {
    handle.store.setState({
      hostTransportStatus: "open",
      cloudSyncStatus: "connected",
      hasFreshCloudSyncStatus: true,
      hasConnectedOnce: true,
      isDirty: false,
      rootDirty: false,
      hasDirtySnapshotForOpenCycle: true,
      artifactRoomDirtyByArtifactRoomId: {},
    });
  }

  it("treats an artifact-room record absent from a received snapshot as clean", () => {
    const handle = createHandle("epic-dirty-absent");
    healthyBaseline(handle);

    const { result } = renderHook(() => useEpicSyncPillState(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("synced");
  });

  it("treats an empty pre-snapshot map as unknown, never synced", () => {
    const handle = createHandle("epic-dirty-unknown");
    healthyBaseline(handle);
    handle.store.setState({
      rootDirty: null,
      hasDirtySnapshotForOpenCycle: false,
      artifactRoomDirtyByArtifactRoomId: {},
    });

    const { result } = renderHook(() => useEpicSyncPillState(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("connected");
  });

  it("treats an explicit false record the same as an absent one", () => {
    const handle = createHandle("epic-dirty-false");
    healthyBaseline(handle);
    handle.store.setState({
      artifactRoomDirtyByArtifactRoomId: { "room-a": false },
    });

    const { result } = renderHook(() => useEpicSyncPillState(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("synced");
  });

  it("is dirty when any one room in the map is dirty, not only when all are", () => {
    const handle = createHandle("epic-dirty-any");
    healthyBaseline(handle);
    handle.store.setState({
      artifactRoomDirtyByArtifactRoomId: { "room-a": false, "room-b": true },
    });

    const { result } = renderHook(() => useEpicSyncPillState(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("hostPending");
  });

  it("flips hostPending -> synced live as a room's dirty flag flips true -> false", () => {
    const handle = createHandle("epic-dirty-transition");
    healthyBaseline(handle);
    handle.store.setState({
      artifactRoomDirtyByArtifactRoomId: { "room-a": true },
    });

    const { result } = renderHook(() => useEpicSyncPillState(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("hostPending");

    act(() => {
      handle.store.setState({
        artifactRoomDirtyByArtifactRoomId: { "room-a": false },
      });
    });

    expect(result.current).toBe("synced");
  });

  it("includes the root doc in host dirtiness", () => {
    const handle = createHandle("epic-root-dirty");
    healthyBaseline(handle);
    handle.store.setState({ rootDirty: true });

    const { result } = renderHook(() => useEpicSyncPillState(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe("hostPending");

    act(() => {
      handle.store.setState({ rootDirty: false });
    });

    expect(result.current).toBe("synced");
  });
});

describe("agent role selectors", () => {
  const claim = {
    claimId: "11111111-1111-4111-8111-111111111111",
    agentId: "agent-1",
    userId: "user-1",
    role: "Planner",
    scope: "selector tests",
    claimedAt: 1,
  };

  it("hides projected claims while disabled and restores them without a Yjs update", () => {
    const handle = createHandle("epic-role-selector-gate");
    handle.store.setState({
      agentRoles: { byAgentId: { "agent-1": [claim] } },
    });

    const { result, rerender } = renderHook(
      () => ({
        claims: useEpicAgentRoleClaims("agent-1"),
        byAgent: useEpicAgentRoleClaimsByAgentId(),
      }),
      { wrapper: openEpicWrapper(handle) },
    );
    expect(result.current.claims).toEqual([claim]);
    expect(result.current.byAgent).toEqual({ "agent-1": [claim] });

    featureSettings.enabled = false;
    rerender();
    expect(result.current.claims).toEqual([]);
    expect(result.current.byAgent).toEqual({});

    featureSettings.enabled = true;
    rerender();
    expect(result.current.claims).toEqual([claim]);
    expect(result.current.byAgent).toEqual({ "agent-1": [claim] });
  });
});

function createHandle(epicId: string): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId,
    userId: null,
    streamClientFactory: fakeStreamClientFactory,
    onAuthError: null,
  });
  handles.push(handle);
  return handle;
}

function openEpicWrapper(handle: OpenEpicStoreHandle) {
  return function OpenEpicWrapper(props: { readonly children: ReactNode }) {
    return (
      <EpicSessionContext.Provider value={handle}>
        {props.children}
      </EpicSessionContext.Provider>
    );
  };
}

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function chat(id: string, harnessId: GuiHarnessId | null): ChatProjection {
  const settings: ChatRunSettings | null =
    harnessId === null
      ? null
      : {
          harnessId,
          model: "test-model",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        };
  return {
    id,
    title: "Chat",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
    isTitleEditedByUser: false,
    archivedAt: null,
    settings,
  };
}

function tuiAgent(id: string, harnessId: TuiHarnessId): TuiAgentProjection {
  return {
    id,
    harnessId,
    title: "Codex",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    archivedAt: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
  };
}
