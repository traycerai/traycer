/**
 * Task-level activity aggregation, with the layering that survived the move to
 * per-user presence: an open chat session that reads some activity is
 * authoritative for its own tier, and host-published presence backfills
 * everything else.
 *
 * The load-bearing case is the last pair: presence for an epic this window has
 * NEVER opened must show through (no projection to check it against), while
 * presence naming an agent a LIVE projection no longer holds must be filtered
 * out. Both look like "an empty candidate set" if you only count ids, which is
 * why the hook distinguishes "no session" from "a session with no agents".
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import {
  publishAgentActivity,
  resetAgentActivityPresence,
} from "@/__tests__/agent-activity-presence-harness";

const EPIC_ID = "epic-activity";
const AGENT_ID = "chat-1";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function registerEmptySession(): void {
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
    createOpenEpicStore({
      epicId: EPIC_ID,
      userId: null,
      streamClientFactory: noopStreamClientFactory,
      onAuthError: null,
    }),
  );
}

function publishWorking(agentIds: readonly string[], turnIds: unknown): void {
  publishAgentActivity([
    {
      hostId: "host-a",
      byEpic: { [EPIC_ID]: { working: agentIds, turn: turnIds } },
    },
  ]);
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
  resetAgentActivityPresence();
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

  it("degrades an unclassified host's working ids to a turn", () => {
    const { result } = renderHook(() => useEpicActivityStatus(EPIC_ID));
    act(() => {
      publishWorking([AGENT_ID], "not an array");
    });
    expect(result.current).toBe("turn");
  });

  it("filters presence against a live projection that no longer holds the agent", () => {
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
    // host-published presence has to show through rather than staying
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

  it("reads idle for a null epic id", () => {
    const { result } = renderHook(() => useEpicActivityStatus(null));
    act(() => {
      publishWorking([AGENT_ID], [AGENT_ID]);
    });
    expect(result.current).toBe("idle");
  });
});
