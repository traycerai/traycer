import { useMemo, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth/auth-store";
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
  deriveEpicCloudFreshnessView,
  epicNodeRefForNodeId,
  useEpicArtifactRecords,
  useEpicChatBackupHasNoCloudTask,
  useEpicChatHarnessId,
  useEpicAgentRoleClaims,
  useEpicAgentRoleClaimsByAgentId,
  useEpicAgentReference,
  useEpicCommentsHaveNoUsableRoom,
  useEpicSyncPillState,
  useMaybeEpicTuiAgentHarnessId,
  useRegisteredEpicLiveAgents,
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
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type {
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";

const handles: OpenedStoreForTest[] = [];

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  featureSettings.enabled = true;
  for (const handle of handles) {
    handle.dispose();
  }
  handles.length = 0;
});

describe("useRegisteredEpicLiveAgents", () => {
  it("subscribes when a registered handle initially has no title", () => {
    const registry = __getOpenEpicRegistryForTests();
    const { result } = renderHook(() =>
      useRegisteredEpicLiveAgents([
        { epicId: "epic-late-handle", agentId: "chat-1" },
      ]),
    );
    expect(result.current).toEqual([null]);

    const handle = openStoreForTest({
      epicId: "epic-late-handle",
      userId: null,
      // The factories go to the COMPOSITION now: the store stopped
      // constructing a runtime, so a `streamClientFactory` has nowhere
      // else to go.
      factories: {
        streamClientFactory: fakeStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
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
    expect(result.current).toEqual([
      { kind: "chat", title: null, hostId: "host-a" },
    ]);

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

    expect(result.current).toEqual([
      { kind: "chat", title: "Generated title", hostId: "host-a" },
    ]);
  });

  it("subscribes to a late handle when the refs identity is stable", () => {
    const registry = __getOpenEpicRegistryForTests();
    const { result } = renderHook(() => {
      const refs = useMemo(
        () => [{ epicId: "epic-stable-refs", agentId: "chat-1" }],
        [],
      );
      return useRegisteredEpicLiveAgents(refs);
    });
    expect(result.current).toEqual([null]);

    const handle = openStoreForTest({
      epicId: "epic-stable-refs",
      userId: null,
      // The factories go to the COMPOSITION now: the store stopped
      // constructing a runtime, so a `streamClientFactory` has nowhere
      // else to go.
      factories: {
        streamClientFactory: fakeStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
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
    expect(result.current).toEqual([
      { kind: "chat", title: null, hostId: "host-a" },
    ]);

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

    expect(result.current).toEqual([
      { kind: "chat", title: "Stable refs title", hostId: "host-a" },
    ]);
  });

  it("resolves a tuiAgents entry to a terminal-agent live agent", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openStoreForTest({
      epicId: "epic-terminal-agent",
      userId: null,
      // The factories go to the COMPOSITION now: the store stopped
      // constructing a runtime, so a `streamClientFactory` has nowhere
      // else to go.
      factories: {
        streamClientFactory: fakeStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    });
    handle.store.setState({
      tuiAgents: {
        allIds: ["agent-1"],
        byId: { "agent-1": tuiAgent("agent-1", "codex") },
      },
    });
    act(() => {
      registry.acquire("epic-terminal-agent", () => handle);
    });

    const { result } = renderHook(() =>
      useRegisteredEpicLiveAgents([
        { epicId: "epic-terminal-agent", agentId: "agent-1" },
      ]),
    );

    expect(result.current).toEqual([
      { kind: "terminal-agent", title: "Codex", hostId: "host-a" },
    ]);
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
  it("preserves a persisted chat owner and uses the SESSION host only as its legacy fallback", () => {
    const handle = createHandle("epic-records-host");
    handleHostIds.set(handle, "host-session");
    handle.store.setState({
      chats: {
        allIds: ["owned-chat", "legacy-chat"],
        byId: {
          "owned-chat": chat("owned-chat", "claude"),
          "legacy-chat": {
            ...chat("legacy-chat", "claude"),
            hostId: null,
          },
        },
      },
    });
    const { result } = renderHook(() => useEpicArtifactRecords(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current.find((row) => row.id === "owned-chat")?.hostId).toBe(
      "host-a",
    );
    expect(result.current.find((row) => row.id === "legacy-chat")?.hostId).toBe(
      "host-session",
    );
    expect(
      epicNodeRefForNodeId(
        handle.store.getState(),
        "owned-chat",
        "host-session",
      )?.hostId,
    ).toBe("host-a");
  });
});

describe("useEpicAgentReference", () => {
  const chatId = "9600b202-1111-4111-8111-111111111111";
  const tuiAgentId = "beefcafe-2222-4222-8222-222222222222";

  function handleWithAgents(epicId: string): OpenedStoreForTest {
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
  function healthyBaseline(handle: OpenedStoreForTest): void {
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

function createHandle(epicId: string): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: epicId,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped
    // constructing a runtime, so a `streamClientFactory` has nowhere
    // else to go.
    factories: {
      streamClientFactory: fakeStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handles.push(handle);
  return handle;
}

describe("useEpicCommentsHaveNoUsableRoom", () => {
  // The gate has a second question beside the structural one - whether this
  // session may reach a cloud-backed room - so every structural case below
  // runs under a session that holds a cloud verdict. The verdict cases are
  // at the end.
  beforeEach(() => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-gate", userName: "U", email: "u@example.com" },
        { userId: "user-gate", username: "U" },
        [],
      );
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  const demoteToUnverified = (): void => {
    useAuthStore
      .getState()
      .setUnverifiedSession(
        { userId: "user-gate", userName: "U", email: "u@example.com" },
        { userId: "user-gate", username: "U" },
      );
  };

  it("gates a cloud-backed room once the session holds no cloud verdict", () => {
    // The room exists and is reachable - structurally `available` - but the
    // poll and every write would go through the local-host context, which
    // carries no renderer verdict. A demotion while the epic stays mounted
    // must close the gate on the next render.
    const handle = createHandle("epic-comment-gate-unverified-cloud");
    handle.store.setState({
      durabilityStatus: "cloud",
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityLegsNegotiated: true,
    });
    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });
    expect(result.current).toBe(false);

    act(() => {
      demoteToUnverified();
    });
    expect(result.current).toBe(true);
  });

  it("keeps a local-homed room open without a cloud verdict", () => {
    // The exemption: a local room is on this disk and spends nothing.
    demoteToUnverified();
    const handle = createHandle("epic-comment-gate-unverified-local");
    handle.store.setState({
      durabilityStatus: "local",
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityLegsNegotiated: true,
    });
    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });
    expect(result.current).toBe(false);
  });

  it("gates a legacy peer's room without a cloud verdict - it has no local homes", () => {
    demoteToUnverified();
    const handle = createHandle("epic-comment-gate-unverified-legacy");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityStatusNegotiated: false,
      durabilityLegsNegotiated: false,
    });
    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });
    expect(result.current).toBe(true);
  });

  it("keeps local-home comments enabled across a subscription cycle's reset", () => {
    // Local artifact rooms now carry a disconnected provider backed by their
    // WAL, so the retained local answer must not disable the comment surface.
    const handle = createHandle("epic-comment-gate-sticky");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: "local",
      retainedDurabilityPauseReason: null,
      durabilityLegsNegotiated: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });

  it("gates comments during the promoting window before the cloud room is ready", () => {
    const handle = createHandle("epic-comment-gate-promoting");
    handle.store.setState({
      durabilityStatus: "promoting",
      durabilityPauseReason: null,
      retainedDurabilityStatus: "local",
      retainedDurabilityPauseReason: null,
      durabilityLegsNegotiated: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(true);
  });

  it("holds a HAS-cloud-room answer across the same reset", () => {
    // The load-bearing half. Both the latch and a blanket
    // "gate whenever silent" answer `true` above, so that case alone cannot
    // tell them apart - and a blanket gate would disable comments on every
    // ordinary cloud epic for the whole reconnect window. Only the retained
    // fact distinguishes an epic KNOWN to have a room from one nothing has
    // spoken about.
    const handle = createHandle("epic-comment-gate-cloud");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: "cloud",
      retainedDurabilityPauseReason: null,
      durabilityLegsNegotiated: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });

  it("keeps comments enabled for a peer that never negotiated the durability legs", () => {
    // The cohort a conservative default would otherwise disable FOREVER: a
    // pre-`@1.6` host cannot emit `durability` at all, so its `null` is not a
    // cycle that has yet to answer - it is a peer that never will, and it has
    // always had working comments.
    const handle = createHandle("epic-comment-gate-legacy");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityLegsNegotiated: false,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });

  it("gates a pre-status @1.4 peer independently of the @1.6 durability legs", () => {
    // @1.4 peers can report durability status even when they do not have the
    // later local/cloud legs. Initial silence is therefore a settling window,
    // not legacy reassurance.
    const handle = createHandle("epic-comment-gate-status-only");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityStatusNegotiated: true,
      durabilityLegsNegotiated: false,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(true);
  });

  it("reads a @1.4/@1.5 peer's frame without the datum as the cloud answer, not as pending", () => {
    // Through @1.5 the enum has no `cloud` member: an ordinary cloud-homed
    // epic is the ABSENT key on every frame such a peer sends. RED before the
    // fix: `checking` forever, comments disabled on a healthy cloud epic.
    const handle = createHandle("epic-comment-gate-pre16-frame");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityStatusNegotiated: true,
      durabilityLegsNegotiated: false,
      hasFreshCloudSyncStatus: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });

  it("keeps a @1.6 peer's frame without the datum pending: its absence means unknown", () => {
    // The @1.6 peer can say `cloud`; a frame that does not is the
    // indeterminate state the widening exists to express.
    const handle = createHandle("epic-comment-gate-16-frame");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityStatusNegotiated: true,
      durabilityLegsNegotiated: true,
      hasFreshCloudSyncStatus: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(true);
  });

  it("does not gate a peer with only the later @1.6 legs negotiated", () => {
    // The @1.6 legs are not evidence that this peer can emit the status this
    // selector waits for. Treating them as the old gate would disable every
    // pre-status peer forever.
    const handle = createHandle("epic-comment-gate-legs-only");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      durabilityStatusNegotiated: false,
      durabilityLegsNegotiated: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });

  it("holds the retained answer through the state a real reconnect produces", () => {
    // The two tests above hand-set `durabilityLegsNegotiated: true` beside a
    // null status, and no production transition produces that pair. A
    // reconnect runs `startedSubscriptionCycle`, which nulls the status AND
    // resets the legs to `false` in the same block, while deliberately
    // leaving the retained pair standing - so the real state is the exact
    // inverse of the fixture, and a gate that consulted the legs before the
    // retained value answered `false` precisely when the latch was needed.
    //
    // Distinguished from the legacy-peer case below it by the retained value
    // alone: that cohort has never emitted a durability status, so it can
    // never hold one.
    const handle = createHandle("epic-comment-gate-reconnect");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: "paused",
      retainedDurabilityPauseReason: "orphaned-local-edits-after-cloud-delete",
      // What the reconnect actually leaves behind.
      durabilityLegsNegotiated: false,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(true);
  });

  it("prefers THIS cycle's statement over the retained one", () => {
    // The retained fact is a fallback for silence, never an override: an epic
    // that finishes promoting says `cloud` and comments must come back at once
    // rather than waiting for the retained value to age out.
    const handle = createHandle("epic-comment-gate-current-wins");
    handle.store.setState({
      durabilityStatus: "cloud",
      durabilityPauseReason: null,
      retainedDurabilityStatus: "local",
      retainedDurabilityPauseReason: null,
      durabilityLegsNegotiated: true,
    });

    const { result } = renderHook(() => useEpicCommentsHaveNoUsableRoom(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });
});

describe("useEpicChatBackupHasNoCloudTask", () => {
  it("uses the retained orphaned pause during a real reconnect shape", () => {
    const handle = createHandle("epic-chat-backup-reconnect");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: "paused",
      retainedDurabilityPauseReason: "orphaned-local-edits-after-cloud-delete",
      durabilityLegsNegotiated: false,
    });

    const { result } = renderHook(() => useEpicChatBackupHasNoCloudTask(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(true);
  });

  it("prefers a live cloud statement over retained local state", () => {
    const handle = createHandle("epic-chat-backup-current-wins");
    handle.store.setState({
      durabilityStatus: "cloud",
      durabilityPauseReason: null,
      retainedDurabilityStatus: "local",
      retainedDurabilityPauseReason: null,
      durabilityLegsNegotiated: true,
    });

    const { result } = renderHook(() => useEpicChatBackupHasNoCloudTask(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });

  it("leaves legacy peers without a retained statement ungated", () => {
    const handle = createHandle("epic-chat-backup-legacy");
    handle.store.setState({
      durabilityStatus: null,
      durabilityPauseReason: null,
      retainedDurabilityStatus: null,
      retainedDurabilityPauseReason: null,
      durabilityLegsNegotiated: false,
    });

    const { result } = renderHook(() => useEpicChatBackupHasNoCloudTask(), {
      wrapper: openEpicWrapper(handle),
    });

    expect(result.current).toBe(false);
  });
});

function openEpicWrapper(handle: OpenedStoreForTest) {
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
    // Ordinary registry-backed chat - this suite exercises selector
    // behavior, not doc residency.
    docResident: false,
    archivedAt: null,
    settings,
  };
}

function tuiAgent(id: string, harnessId: TuiHarnessId): TuiAgentProjection {
  return {
    id,
    // An ordinary registry-backed agent - this suite exercises selector
    // behavior, not doc residency.
    docResident: false,
    origin: "registry",
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

/**
 * `deriveEpicCloudFreshnessView` - `s5-mirror-first-serving`.
 *
 * The ONE reading of the wire datum, and the place the class-level correction
 * lives: the host derives an honest state, and before the s5 pass each
 * renderer resolved a missing one into the calm value independently. There is
 * deliberately no arm below that turns an absence into `current`.
 */
describe("deriveEpicCloudFreshnessView", () => {
  it("reads an absent datum as unknown, never as current", () => {
    const view = deriveEpicCloudFreshnessView(null);
    expect(view).toEqual({ kind: "unknown" });
    // Stated as its own assertion because it is the inference the whole s5
    // status pass exists to break, and `toEqual` above would still pass if
    // `unknown` were ever redefined to mean "fine".
    expect(view.kind === "stated" ? view.state : null).not.toBe("current");
  });

  it("carries the persisted stamp through, which is what licenses a current claim", () => {
    expect(
      deriveEpicCloudFreshnessView({
        kind: "lastCloudSyncAt",
        reconciledAtEpochMs: 1_700_000_000_000,
        state: "current",
      }),
    ).toEqual({
      kind: "stated",
      state: "current",
      reconciledAtEpochMs: 1_700_000_000_000,
    });
  });

  it("flattens the timestamp-less arm to a null stamp while keeping its state", () => {
    // `current` is not a member of that arm's enum on the wire, so a renderer
    // reading this view can never be handed a currency claim with nothing
    // behind it - the impossibility is structural, not conventional.
    expect(
      deriveEpicCloudFreshnessView({
        kind: "freshnessUnknown",
        state: "stale",
      }),
    ).toEqual({ kind: "stated", state: "stale", reconciledAtEpochMs: null });
  });
});
