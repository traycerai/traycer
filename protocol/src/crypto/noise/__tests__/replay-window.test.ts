import { describe, it, expect } from "vitest";
import { ReplayWindow } from "../replay-window";

/**
 * Security-gate bar #3 (sliding-window half): monotonic-ish acceptance with
 * out-of-order tolerance, and hard rejection of replays and too-old counters.
 * `check` must be a pure predicate; only `commit` advances state.
 */
describe("ReplayWindow", () => {
  it("rejects a non-positive size", () => {
    expect(() => new ReplayWindow(0)).toThrow();
    expect(() => new ReplayWindow(-1)).toThrow();
  });

  it("accepts the first counter and any strictly-increasing sequence", () => {
    const w = new ReplayWindow(64);
    for (const c of [0n, 1n, 2n, 3n, 100n]) {
      expect(w.check(c)).toBe(true);
      w.commit(c);
    }
  });

  it("rejects an exact replay of an accepted counter", () => {
    const w = new ReplayWindow(64);
    w.commit(0n);
    w.commit(1n);
    w.commit(2n);
    expect(w.check(1n)).toBe(false);
    expect(w.check(2n)).toBe(false);
  });

  it("accepts out-of-order frames within the window, then rejects their replay", () => {
    const w = new ReplayWindow(64);
    w.commit(10n);
    // 7 arrives late but is inside the window and unseen -> accept.
    expect(w.check(7n)).toBe(true);
    w.commit(7n);
    // its replay is now rejected.
    expect(w.check(7n)).toBe(false);
    // a different in-window unseen counter still accepts.
    expect(w.check(5n)).toBe(true);
  });

  it("rejects counters older than the window even if never seen", () => {
    const w = new ReplayWindow(8);
    w.commit(100n);
    // window covers [93, 100]; 92 and below are unconditionally rejected.
    expect(w.check(92n)).toBe(false);
    expect(w.check(93n)).toBe(true);
  });

  it("forgets counters that scroll out of the window (they become replays)", () => {
    const w = new ReplayWindow(4);
    w.commit(0n);
    expect(w.check(0n)).toBe(false); // seen
    // advance far enough that 0 falls out of the 4-wide window.
    w.commit(10n);
    expect(w.check(0n)).toBe(false); // now too old, still rejected
    expect(w.check(9n)).toBe(true); // in window, unseen
  });

  it("check() does not mutate state (idempotent predicate)", () => {
    const w = new ReplayWindow(64);
    w.commit(5n);
    expect(w.check(6n)).toBe(true);
    expect(w.check(6n)).toBe(true); // still acceptable; check didn't commit it
    w.commit(6n);
    expect(w.check(6n)).toBe(false);
  });

  it("handles a large 64-bit jump without losing anti-replay", () => {
    const w = new ReplayWindow(1024);
    const big = 2n ** 63n;
    w.commit(big);
    expect(w.check(big)).toBe(false); // replay of the big counter
    expect(w.check(big + 1n)).toBe(true);
    expect(w.check(big - 1n)).toBe(true); // in window, unseen
    expect(w.check(big - 2000n)).toBe(false); // out of window
  });
});
