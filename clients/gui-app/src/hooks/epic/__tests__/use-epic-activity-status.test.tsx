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
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";

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
    createOpenEpicStore({
      epicId: EPIC_ID,
      userId: null,
      streamClientFactory: noopStreamClientFactory,
      onAuthError: null,
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
        hostId: "host-a",
        epicId: EPIC_ID,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
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
    status: { state: "running", pid: 4242, startedAtMs: 1 },
    chatId,
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
      __getOpenEpicRegistryForTests().release(EPIC_ID);
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
