import { describe, expect, it } from "vitest";
import {
  DwellLatch,
  type DwellState,
  type DwellTimer,
} from "@/components/epic-canvas/dnd/dwell-latch";

/** Fake clock: nothing fires unless the test advances it. */
function fakeTimer() {
  const pending = new Map<number, { cb: () => void; at: number }>();
  let next = 1;
  let now = 0;
  const timer: DwellTimer = {
    set: (cb, ms) => {
      const id = next++;
      pending.set(id, { cb, at: now + ms });
      return id;
    },
    clear: (id) => {
      pending.delete(id);
    },
  };
  return {
    timer,
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.cb();
        }
      }
    },
    now: () => now,
    pendingCount: () => pending.size,
  };
}

function makeLatch(dwellMs = 400, stillnessPx = 6) {
  const clock = fakeTimer();
  const states: DwellState[] = [];
  const latch = new DwellLatch({
    dwellMs,
    stillnessPx,
    timer: clock.timer,
    onChange: (s) => states.push(s),
  });
  return { latch, clock, states };
}

describe("DwellLatch", () => {
  it("fires with no further observations - the defect this exists to prevent", () => {
    // A stationary pointer emits no events. If the latch needed a caller to
    // re-invoke it, this test would hang at "armed" forever - which is exactly
    // how the gesture died silently, twice, in two different sites.
    const { latch, clock, states } = makeLatch(400);
    latch.observe({ key: "target-a", point: { x: 10, y: 10 }, nowMs: 0 });
    expect(latch.getState().kind).toBe("armed");

    clock.advance(401);

    expect(latch.getState().kind).toBe("fired");
    expect(latch.isFired("target-a")).toBe(true);
    expect(states.map((s) => s.kind)).toEqual(["armed", "fired"]);
  });

  it("always owns a pending timer while armed", () => {
    const { latch, clock } = makeLatch(400);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    expect(clock.pendingCount()).toBe(1);
  });

  it("does not fire early", () => {
    const { latch, clock } = makeLatch(400);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    clock.advance(399);
    expect(latch.getState().kind).toBe("armed");
  });

  it("re-anchors on drift so the original deadline passes unfired", () => {
    const { latch, clock } = makeLatch(400, 6);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    // Moved beyond the budget at t=200: the clock restarts from there.
    latch.observe({ key: "a", point: { x: 20, y: 0 }, nowMs: 200 });
    clock.advance(250);
    expect(latch.getState().kind).toBe("armed");
    clock.advance(200);
    expect(latch.getState().kind).toBe("fired");
  });

  it("tolerates movement inside the stillness budget", () => {
    const { latch, clock } = makeLatch(400, 6);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    latch.observe({ key: "a", point: { x: 3, y: 2 }, nowMs: 200 });
    clock.advance(401);
    expect(latch.getState().kind).toBe("fired");
  });

  it("cancels immediately when the target changes", () => {
    // Planner requirement: leaving a target cancels the dwell immediately, with
    // no residual arm carried onto whatever is next.
    const { latch, clock } = makeLatch(400);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    clock.advance(390);
    latch.observe({ key: "b", point: { x: 0, y: 0 }, nowMs: 390 });
    clock.advance(20);
    expect(latch.getState()).toEqual({ kind: "armed", key: "b", sinceMs: 390 });
    expect(latch.isFired("a")).toBe(false);
  });

  it("resets on a null target and drops its timer", () => {
    const { latch, clock } = makeLatch(400);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    latch.observe({ key: null, point: { x: 0, y: 0 }, nowMs: 100 });
    expect(latch.getState().kind).toBe("idle");
    expect(clock.pendingCount()).toBe(0);
    clock.advance(1000);
    expect(latch.getState().kind).toBe("idle");
  });

  it("stays fired without re-arming while the pointer holds", () => {
    const { latch, clock, states } = makeLatch(400);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    clock.advance(401);
    latch.observe({ key: "a", point: { x: 1, y: 1 }, nowMs: 500 });
    latch.observe({ key: "a", point: { x: 2, y: 1 }, nowMs: 600 });
    expect(latch.getState().kind).toBe("fired");
    expect(states.filter((s) => s.kind === "fired")).toHaveLength(1);
  });

  it("keeps per-caller timings distinct", () => {
    // Converging the mechanism must not converge the feel: header merge and
    // edge split dwell at 400ms, a pane body at 220ms.
    const slow = makeLatch(400);
    const fast = makeLatch(220);
    slow.latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    fast.latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    slow.clock.advance(230);
    fast.clock.advance(230);
    expect(slow.latch.getState().kind).toBe("armed");
    expect(fast.latch.getState().kind).toBe("fired");
  });

  it("reset() after firing returns to idle", () => {
    const { latch, clock } = makeLatch(400);
    latch.observe({ key: "a", point: { x: 0, y: 0 }, nowMs: 0 });
    clock.advance(401);
    latch.reset();
    expect(latch.getState().kind).toBe("idle");
  });
});
