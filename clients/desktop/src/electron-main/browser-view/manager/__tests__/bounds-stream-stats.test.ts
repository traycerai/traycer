import { describe, expect, it } from "vitest";
import { createBoundsStreamStats } from "../bounds-stream-stats";

describe("createBoundsStreamStats", () => {
  it("returns null when nothing was recorded", () => {
    const stats = createBoundsStreamStats();
    expect(stats.drain(1000)).toBeNull();
  });

  it("aggregates outcomes and resets after drain", () => {
    const stats = createBoundsStreamStats();
    stats.recordApplied(null);
    stats.recordApplied(12);
    stats.recordCoalesced();
    stats.recordCoalesced();
    stats.recordCoalesced();
    stats.recordRejected();

    expect(stats.drain(500)).toEqual({
      windowMs: 500,
      received: 6,
      applied: 2,
      coalesced: 3,
      rejected: 1,
      maxDeltaPx: 12,
    });
    expect(stats.drain(500)).toBeNull();
  });

  it("keeps the maximum component delta across applied updates", () => {
    const stats = createBoundsStreamStats();
    stats.recordApplied(4);
    stats.recordApplied(40);
    stats.recordApplied(17);

    expect(stats.drain(1000)?.maxDeltaPx).toBe(40);
  });

  it("ignores null deltas when tracking the maximum", () => {
    const stats = createBoundsStreamStats();
    stats.recordApplied(null);
    expect(stats.drain(1000)?.maxDeltaPx).toBeNull();
  });
});
