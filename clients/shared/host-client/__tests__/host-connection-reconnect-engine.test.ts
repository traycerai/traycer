import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamCloseReason } from "../../host-transport/i-stream-session";
import {
  createHostReconnectEngine,
  HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS,
  HOST_STREAM_REOPEN_MAX_BACKOFF_MS,
  WAKE_RETRY_EPISODE_MS,
  isReopenableHostStreamClose,
  isReopenableNotificationsStreamClose,
  processReconnectEngine,
  resetProcessReconnectEngineForTest,
  type HostReconnectEngine,
} from "../host-connection-reconnect-engine";

// The module holds a PROCESS-scoped singleton (`processReconnectEngine`), and
// it is exercised directly below - clear it after every test so a leftover
// instance never leaks into an unrelated suite in this same file.
afterEach(() => {
  resetProcessReconnectEngineForTest();
});

function fatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

describe("rebuild pacer (R9)", () => {
  let engine: HostReconnectEngine;

  beforeEach(() => {
    engine = createHostReconnectEngine();
  });

  it("returns 0 on the first quick close - instant recovery is the point", () => {
    const pacer = engine.createRebuildPacer();
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(100)).toBe(0);
  });

  it("starts the backoff on the second consecutive quick close", () => {
    const pacer = engine.createRebuildPacer();
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(0)).toBe(0); // quick close #1: instant
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(0)).toBe(1_000); // quick close #2: backoff begins
  });

  it("doubles the backoff and caps it at 30s", () => {
    const pacer = engine.createRebuildPacer();
    let t = 0;
    pacer.markBuilt(t, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(t)).toBe(0); // quick close #1

    // Quick closes #2 through #8: 1s, 2s, 4s, 8s, 16s, then capped at 30s.
    const expectedDelaysMs = [
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ];
    for (const expected of expectedDelaysMs) {
      t += 10;
      pacer.markBuilt(t, "endpoint-a");
      expect(pacer.nextRebuildDelayMs(t)).toBe(expected);
    }
  });

  it("resets the streak once a client survives the healthy lifetime before closing", () => {
    const pacer = engine.createRebuildPacer();
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(0)).toBe(0); // quick close #1
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(0)).toBe(1_000); // quick close #2: backoff underway

    // This client lives >= the 30s healthy lifetime before closing.
    pacer.markBuilt(1_000, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(1_000 + 30_000)).toBe(0); // streak reset
  });

  it("clears the streak on a change of transportIdentity", () => {
    const pacer = engine.createRebuildPacer();
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(0)).toBe(0);
    pacer.markBuilt(0, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(0)).toBe(1_000); // backoff underway on endpoint-a

    pacer.markBuilt(0, "endpoint-b"); // a genuine move to a different endpoint
    expect(pacer.nextRebuildDelayMs(0)).toBe(0); // streak cleared - back to quick close #1
  });

  it("does NOT clear the streak when adopting the FIRST identity", () => {
    // The opening observation: a client already closed before anything was
    // ever built (no `markBuilt` call yet). This must be counted, not erased
    // by the very rebuild it triggers - so the first `markBuilt` (identity
    // moving from null to a real value) must not reset the streak.
    const pacer = engine.createRebuildPacer();
    expect(pacer.nextRebuildDelayMs(0)).toBe(0); // pre-build close: quick close #1

    pacer.markBuilt(0, "endpoint-a"); // adopting the FIRST identity
    expect(pacer.nextRebuildDelayMs(0)).toBe(1_000); // streak continued to #2, not reset
  });
});

describe("close-reason predicates", () => {
  it("isReopenableHostStreamClose rejects CLIENT_CLOSED and INCOMPATIBLE, accepts other fatals", () => {
    expect(isReopenableHostStreamClose(null)).toBe(false);
    expect(isReopenableHostStreamClose({ kind: "caller" })).toBe(false);
    expect(isReopenableHostStreamClose(fatalClose("CLIENT_CLOSED"))).toBe(
      false,
    );
    expect(isReopenableHostStreamClose(fatalClose("INCOMPATIBLE"))).toBe(false);
    expect(isReopenableHostStreamClose(fatalClose("INTERNAL"))).toBe(true);
    expect(
      isReopenableHostStreamClose(fatalClose("FREE_TIER_NO_CLOUD_SYNC")),
    ).toBe(true);
  });

  it("isReopenableNotificationsStreamClose additionally rejects FREE_TIER_NO_CLOUD_SYNC", () => {
    expect(
      isReopenableNotificationsStreamClose(
        fatalClose("FREE_TIER_NO_CLOUD_SYNC"),
      ),
    ).toBe(false);
    expect(
      isReopenableNotificationsStreamClose(fatalClose("CLIENT_CLOSED")),
    ).toBe(false);
    expect(
      isReopenableNotificationsStreamClose(fatalClose("INCOMPATIBLE")),
    ).toBe(false);
    expect(isReopenableNotificationsStreamClose(fatalClose("INTERNAL"))).toBe(
      true,
    );
  });
});

describe("reopen lanes (R10)", () => {
  let engine: HostReconnectEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = createHostReconnectEngine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-ops scheduleAfterClose for a non-reopenable close", () => {
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);
    lane.scheduleAfterClose(fatalClose("INCOMPATIBLE"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_MAX_BACKOFF_MS * 4);
    expect(reopen).not.toHaveBeenCalled();
  });

  it("no-ops scheduleAfterClose while a reopen is already pending", () => {
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);
    lane.scheduleAfterClose(fatalClose("INTERNAL"));
    lane.scheduleAfterClose(fatalClose("INTERNAL")); // a timer is already armed
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("no-ops scheduleAfterClose after dispose", () => {
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);
    lane.dispose();
    lane.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_MAX_BACKOFF_MS * 4);
    expect(reopen).not.toHaveBeenCalled();
  });

  it("schedules the first reopen at the initial backoff", () => {
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);
    lane.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS - 1);
    expect(reopen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("doubles the backoff on successive reopens and caps at the max", () => {
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);
    const delaysMs = [
      HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS,
      HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 2,
      HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 4,
      HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 8,
      HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 16,
      HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 32,
      HOST_STREAM_REOPEN_MAX_BACKOFF_MS,
      HOST_STREAM_REOPEN_MAX_BACKOFF_MS,
    ];
    for (const [index, delay] of delaysMs.entries()) {
      lane.scheduleAfterClose(fatalClose("INTERNAL"));
      vi.advanceTimersByTime(delay - 1);
      expect(reopen).toHaveBeenCalledTimes(index);
      vi.advanceTimersByTime(1);
      expect(reopen).toHaveBeenCalledTimes(index + 1);
    }
  });

  it("resetBackoff returns the lane to the initial delay", () => {
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);

    lane.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(reopen).toHaveBeenCalledTimes(1);

    // Without a reset the next close would wait the DOUBLED backoff. Assert
    // the exact initial delay to prove the reset actually happened, not just
    // that a reopen eventually fires.
    lane.resetBackoff();
    lane.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS - 1);
    expect(reopen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(reopen).toHaveBeenCalledTimes(2);
  });

  it("paces lanes independently - a sibling's escalated backoff does not pace a fresh lane", () => {
    const reopenA = vi.fn();
    const reopenB = vi.fn();
    const laneA = engine.openReopenLane(reopenA, isReopenableHostStreamClose);
    const laneB = engine.openReopenLane(reopenB, isReopenableHostStreamClose);

    // Drive lane A's backoff well past the initial delay.
    laneA.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    laneA.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 2);
    expect(reopenA).toHaveBeenCalledTimes(2);

    // Lane B's FIRST close still waits only the initial backoff. Folding both
    // lanes onto one shared timer would let A's escalation pace B.
    laneB.scheduleAfterClose(fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS - 1);
    expect(reopenB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reopenB).toHaveBeenCalledTimes(1);
  });
});

describe("wake episode (R12)", () => {
  let engine: HostReconnectEngine;

  beforeEach(() => {
    engine = createHostReconnectEngine();
  });

  it("claims true then false inside the episode window for the same key, true again past it", () => {
    const key = {};
    expect(engine.claimWakeEpisode(key, 0)).toBe(true);
    expect(engine.claimWakeEpisode(key, WAKE_RETRY_EPISODE_MS - 1)).toBe(false);
    expect(engine.claimWakeEpisode(key, WAKE_RETRY_EPISODE_MS)).toBe(true);
  });

  it("keeps distinct keys independent", () => {
    const keyA = {};
    const keyB = {};
    expect(engine.claimWakeEpisode(keyA, 0)).toBe(true);
    expect(engine.claimWakeEpisode(keyB, 0)).toBe(true); // B's own first claim
    expect(engine.claimWakeEpisode(keyB, 1)).toBe(false); // still B's window
    expect(engine.claimWakeEpisode(keyA, 1)).toBe(false); // still A's window
  });

  it("isWithinWakeEpisode agrees with what claim did", () => {
    const key = {};
    expect(engine.isWithinWakeEpisode(key, 0)).toBe(false);
    engine.claimWakeEpisode(key, 0);
    expect(engine.isWithinWakeEpisode(key, WAKE_RETRY_EPISODE_MS - 1)).toBe(
      true,
    );
    expect(engine.isWithinWakeEpisode(key, WAKE_RETRY_EPISODE_MS)).toBe(false);
  });
});

describe("dispose()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels every pending lane timer - a reopen must not fire after dispose", () => {
    const engine = createHostReconnectEngine();
    const reopen = vi.fn();
    const lane = engine.openReopenLane(reopen, isReopenableHostStreamClose);
    lane.scheduleAfterClose(fatalClose("INTERNAL"));

    engine.dispose();

    vi.advanceTimersByTime(HOST_STREAM_REOPEN_MAX_BACKOFF_MS * 4);
    expect(reopen).not.toHaveBeenCalled();
  });
});

describe("processReconnectEngine()", () => {
  it("returns the same instance across calls", () => {
    const first = processReconnectEngine();
    const second = processReconnectEngine();
    expect(second).toBe(first);
  });

  it("resetProcessReconnectEngineForTest gives a fresh instance", () => {
    const first = processReconnectEngine();
    resetProcessReconnectEngineForTest();
    const second = processReconnectEngine();
    expect(second).not.toBe(first);
  });
});
