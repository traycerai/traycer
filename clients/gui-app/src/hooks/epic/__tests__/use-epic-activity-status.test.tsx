/**
 * Task-level activity aggregation, with the layering that survived the move to
 * per-user activity: an open chat session that reads some activity is
 * authoritative for its own tier, and host-published activity backfills
 * everything else.
 *
 * The load-bearing case is the last pair: activity for an epic this window has
 * NEVER opened must show through (no projection to check it against), while
 * activity naming an agent a LIVE projection no longer holds must be filtered
 * out. Both look like "an empty candidate set" if you only count ids, which is
 * why the hook distinguishes "no session" from "a session with no agents".
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  chatSessionWaitingReason,
  epicWaitingReasonFromSessions,
  useEpicActivityStatus,
  useEpicWaitingReason,
} from "@/hooks/epic/use-epic-activity-status";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  createChatSessionStore,
  type ChatSessionState,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-activity";
const AGENT_ID = "chat-1";
const OTHER_AGENT_ID = "chat-2";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function registerEmptySession(): void {
  registerSessionHoldingAgents([]);
}

/**
 * A live epic projection holding `agentIds`. The projection is the liveness
 * filter the aggregation runs its candidates through, so a chat session only
 * counts once its id is in there.
 */
function registerSessionHoldingAgents(agentIds: readonly string[]): void {
  const handle = __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
    openStoreForTest({
      epicId: EPIC_ID,
      userId: null,
      // The factories go to the COMPOSITION now, not the store:
      // `createOpenEpicStore` stopped constructing a runtime, so a
      // suite that used to hand it a `streamClientFactory` has nothing
      // to hand it. `handle.doc` still resolves because this harness
      // builds the runtime in THIS thread.
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    }),
  );
  handle.store.setState({ chats: { allIds: [...agentIds], byId: {} } });
}

/** Sessions are keyed by (epic, chat, host); these aggregate reads scan every
 *  handle, so one host id serves the whole fixture set. */
const ACTIVITY_HOST_ID = "host-1";

/** A live chat session for `chatId`, owning `managedCommands`. */
function registerChatSession(
  chatId: string,
  managedCommands: readonly ManagedCommand[],
): void {
  const handle = __getChatSessionRegistryForTests().acquire(
    {
      epicId: EPIC_ID,
      chatId,
      hostId: ACTIVITY_HOST_ID,
      scopeKey: "activity-test-scope",
    },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: "host-a",
        epicId: EPIC_ID,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      }),
  );
  handle.store.setState({ managedCommands: [...managedCommands] });
}

function runningShell(chatId: string): ManagedCommand {
  return {
    id: `cmd-${chatId}`,
    monitoring: false,
    description: "dev server",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
    status: { state: "running", pid: 4242, startedAtMs: 1 },
    chatId,
    relaunchOnHostRestart: false,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function publishWorking(
  agentIds: readonly string[],
  turnIds: readonly string[],
): void {
  publishAgentActivity([
    {
      hostId: "host-a",
      byEpic: { [EPIC_ID]: { working: agentIds, turn: turnIds } },
    },
  ]);
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
  disposeAllChatSessions();
  resetAgentActivity();
});

describe("useEpicActivityStatus", () => {
  it("reads idle when no host reports work for the epic", () => {
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    expect(result.current).toBe("idle");
  });

  it("reports a turn for an epic this window has never opened", () => {
    // The defect the per-user room fixes: no session, no projection, and the
    // agent is still working.
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });
    expect(result.current).toBe("turn");
  });

  it("reports background-only work for an unopened epic", () => {
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], []);
    });
    expect(result.current).toBe("background");
  });

  it("filters host activity against a live projection that no longer holds the agent", () => {
    // A session IS registered, so its (empty) projection is authoritative and
    // the stale id must not keep a spinner alive.
    registerEmptySession();
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });
    expect(result.current).toBe("idle");
  });

  it("stops filtering once the epic's session is evicted from the MRU", () => {
    // The handle -> null transition the liveness filter turns on. While the
    // session is live its projection is authoritative and suppresses the stale
    // id; the moment the MRU evicts it the epic is UNKNOWN again, so
    // host-published activity has to show through rather than staying
    // suppressed by a projection that no longer exists.
    registerEmptySession();
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });
    expect(result.current).toBe("idle");

    act(() => {
      __getOpenEpicRegistryForTests().release(EPIC_ID, "discard", null);
    });

    expect(result.current).toBe("turn");
  });

  it("clears when the publishing host drops out", () => {
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });
    expect(result.current).toBe("turn");
    act(() => {
      publishAgentActivity([]);
    });
    expect(result.current).toBe("idle");
  });

  it("reports background when one of the epic's chats owns a running shell", () => {
    // Nothing is published for this epic and every chat reads idle: the shell
    // is the only live thing, and the Task tab has to show it.
    registerSessionHoldingAgents([AGENT_ID, OTHER_AGENT_ID]);
    registerChatSession(AGENT_ID, []);
    registerChatSession(OTHER_AGENT_ID, [runningShell(OTHER_AGENT_ID)]);

    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));

    expect(result.current).toBe("background");
  });

  it("reports a turn over a chat whose shell is running", () => {
    registerSessionHoldingAgents([AGENT_ID, OTHER_AGENT_ID]);
    registerChatSession(AGENT_ID, []);
    registerChatSession(OTHER_AGENT_ID, [runningShell(OTHER_AGENT_ID)]);

    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });

    expect(result.current).toBe("turn");
  });

  it("reads idle for a null epic id", () => {
    const { result } = renderHook(() => useEpicActivityStatus(null));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });
    expect(result.current).toBe("idle");
  });
});

const COMMAND_APPROVAL: ChatSessionState["pendingApprovals"][number] = {
  kind: "tool",
  approvalId: "approval-1",
  toolName: "bash",
  description: "Run a command",
  input: null,
  planId: null,
  actions: [],
  requestedAt: 1,
  reason: null,
  reviewing: null,
};

const FILE_EDIT_APPROVAL: ChatSessionState["pendingFileEditApprovals"][number] =
  {
    approvalId: "file-edit-1",
    toolName: "edit",
    description: "Edit a file",
    paths: ["/work/repo/a.ts"],
    operation: "edit",
    input: null,
    requestedAt: 1,
  };

const INTERVIEW: ChatSessionState["pendingInterviews"][number] = {
  blockId: "question-1",
  requestedAt: 1,
};

function chatStore(chatId: string): ChatSessionState {
  const handle = __getChatSessionRegistryForTests().peek(
    EPIC_ID,
    chatId,
    ACTIVITY_HOST_ID,
  );
  if (handle === null) throw new Error(`expected chat session ${chatId}`);
  return handle.store.getState();
}

function setChatGates(
  chatId: string,
  gates: Pick<
    ChatSessionState,
    "pendingApprovals" | "pendingFileEditApprovals" | "pendingInterviews"
  >,
): void {
  const handle = __getChatSessionRegistryForTests().peek(
    EPIC_ID,
    chatId,
    ACTIVITY_HOST_ID,
  );
  if (handle === null) throw new Error(`expected chat session ${chatId}`);
  handle.store.setState(gates);
}

describe("chatSessionWaitingReason", () => {
  it.each<{
    readonly name: string;
    readonly gates: Pick<
      ChatSessionState,
      "pendingApprovals" | "pendingFileEditApprovals" | "pendingInterviews"
    >;
    readonly expected: "approval" | "reply" | null;
  }>([
    {
      name: "reads null for a chat with no gate",
      gates: {
        pendingApprovals: [],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
      },
      expected: null,
    },
    {
      name: "reads reply for a pending interview",
      gates: {
        pendingApprovals: [],
        pendingFileEditApprovals: [],
        pendingInterviews: [INTERVIEW],
      },
      expected: "reply",
    },
    {
      name: "reads approval for a pending command approval",
      gates: {
        pendingApprovals: [COMMAND_APPROVAL],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
      },
      expected: "approval",
    },
    {
      name: "reads null for a command approval still under the auto-judge",
      gates: {
        pendingApprovals: [{ ...COMMAND_APPROVAL, reviewing: "checking" }],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
      },
      expected: null,
    },
    {
      name: "reads approval for a plan approval",
      gates: {
        pendingApprovals: [
          { ...COMMAND_APPROVAL, kind: "plan", planId: "plan-1" },
        ],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
      },
      expected: "approval",
    },
    {
      name: "reads approval for a pending file-edit approval",
      gates: {
        pendingApprovals: [],
        pendingFileEditApprovals: [FILE_EDIT_APPROVAL],
        pendingInterviews: [],
      },
      expected: "approval",
    },
    {
      name: "ranks an interview over an approval in the same chat",
      gates: {
        pendingApprovals: [COMMAND_APPROVAL],
        pendingFileEditApprovals: [],
        pendingInterviews: [INTERVIEW],
      },
      expected: "reply",
    },
  ])("$name", ({ gates, expected }) => {
    registerChatSession(AGENT_ID, []);
    setChatGates(AGENT_ID, gates);
    expect(chatSessionWaitingReason(chatStore(AGENT_ID))).toBe(expected);
  });
});

describe("epicWaitingReasonFromSessions", () => {
  it("ranks reply over approval across two chats, in either order", () => {
    registerSessionHoldingAgents([AGENT_ID, OTHER_AGENT_ID]);
    registerChatSession(AGENT_ID, []);
    registerChatSession(OTHER_AGENT_ID, []);
    const live = new Set([AGENT_ID, OTHER_AGENT_ID]);

    setChatGates(AGENT_ID, {
      pendingApprovals: [COMMAND_APPROVAL],
      pendingFileEditApprovals: [],
      pendingInterviews: [],
    });
    setChatGates(OTHER_AGENT_ID, {
      pendingApprovals: [],
      pendingFileEditApprovals: [],
      pendingInterviews: [INTERVIEW],
    });
    expect(epicWaitingReasonFromSessions(EPIC_ID, live)).toBe("reply");

    setChatGates(AGENT_ID, {
      pendingApprovals: [],
      pendingFileEditApprovals: [],
      pendingInterviews: [INTERVIEW],
    });
    setChatGates(OTHER_AGENT_ID, {
      pendingApprovals: [],
      pendingFileEditApprovals: [FILE_EDIT_APPROVAL],
      pendingInterviews: [],
    });
    expect(epicWaitingReasonFromSessions(EPIC_ID, live)).toBe("reply");
  });

  it("ignores a warm chat the live projection no longer holds", () => {
    registerChatSession(AGENT_ID, []);
    setChatGates(AGENT_ID, {
      pendingApprovals: [COMMAND_APPROVAL],
      pendingFileEditApprovals: [],
      pendingInterviews: [],
    });
    expect(epicWaitingReasonFromSessions(EPIC_ID, new Set())).toBeNull();
    expect(epicWaitingReasonFromSessions(EPIC_ID, null)).toBeNull();
    expect(epicWaitingReasonFromSessions(EPIC_ID, new Set([AGENT_ID]))).toBe(
      "approval",
    );
  });
});

describe("useEpicWaitingReason", () => {
  it("re-renders when a live chat's pending interview resolves", () => {
    registerSessionHoldingAgents([AGENT_ID, OTHER_AGENT_ID]);
    registerChatSession(AGENT_ID, []);
    registerChatSession(OTHER_AGENT_ID, []);
    setChatGates(AGENT_ID, {
      pendingApprovals: [],
      pendingFileEditApprovals: [],
      pendingInterviews: [INTERVIEW],
    });
    setChatGates(OTHER_AGENT_ID, {
      pendingApprovals: [COMMAND_APPROVAL],
      pendingFileEditApprovals: [],
      pendingInterviews: [],
    });

    const { result } = renderHook(() => useEpicWaitingReason(EPIC_ID));
    expect(result.current).toBe("reply");

    act(() => {
      setChatGates(AGENT_ID, {
        pendingApprovals: [],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
      });
    });
    expect(result.current).toBe("approval");

    act(() => {
      setChatGates(OTHER_AGENT_ID, {
        pendingApprovals: [],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
      });
    });
    expect(result.current).toBeNull();
  });

  it("picks up a chat session that registers after mount", () => {
    registerSessionHoldingAgents([AGENT_ID]);
    const { result } = renderHook(() => useEpicWaitingReason(EPIC_ID));
    expect(result.current).toBeNull();

    act(() => {
      registerChatSession(AGENT_ID, []);
      setChatGates(AGENT_ID, {
        pendingApprovals: [],
        pendingFileEditApprovals: [FILE_EDIT_APPROVAL],
        pendingInterviews: [],
      });
    });
    expect(result.current).toBe("approval");
  });

  it("reads null for a null epic id", () => {
    const { result } = renderHook(() => useEpicWaitingReason(null));
    expect(result.current).toBeNull();
  });
});
