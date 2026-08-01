import { describe, expect, it } from "vitest";
import {
  formatPrChecksValue,
  prChecksTone,
} from "@/components/epic-canvas/pr/pr-detail-tone";

/**
 * `total` is not the sum of the three buckets: GitHub also reports skipped,
 * neutral and cancelled contexts, which land in `total` alone. The gauge must
 * not read a run where nothing passed as a green one.
 */
describe("prChecksTone / formatPrChecksValue - contexts outside the buckets", () => {
  it("does not report a green run when every check settled outside the buckets", () => {
    // Four checks, all skipped/neutral/cancelled. Before this was handled,
    // the tone fell through to "ok" and the value read "0 passed" - a green
    // dot next to a count of zero passes.
    const counts = { passed: 0, failing: 0, pending: 0, total: 4 };
    expect(prChecksTone(counts)).toBe("none");
    expect(formatPrChecksValue(counts)).toBe("4 checks");
  });

  it("singularizes the fallback count", () => {
    const counts = { passed: 0, failing: 0, pending: 0, total: 1 };
    expect(formatPrChecksValue(counts)).toBe("1 check");
  });

  it("still reports a genuine pass as ok", () => {
    const counts = { passed: 3, failing: 0, pending: 0, total: 3 };
    expect(prChecksTone(counts)).toBe("ok");
    expect(formatPrChecksValue(counts)).toBe("3 passed");
  });

  it("reports a pass even when unbucketed contexts inflate the total", () => {
    // Something DID pass, so "ok" is honest here; the fallback must not
    // swallow a real pass just because `total` exceeds the bucket sum.
    const counts = { passed: 2, failing: 0, pending: 0, total: 5 };
    expect(prChecksTone(counts)).toBe("ok");
    expect(formatPrChecksValue(counts)).toBe("2 passed");
  });

  it("keeps worst-first ordering ahead of the fallback", () => {
    expect(prChecksTone({ passed: 0, failing: 1, pending: 0, total: 4 })).toBe(
      "fail",
    );
    expect(prChecksTone({ passed: 0, failing: 0, pending: 2, total: 4 })).toBe(
      "pending",
    );
  });

  it("reports nothing at all when there are no checks", () => {
    const counts = { passed: 0, failing: 0, pending: 0, total: 0 };
    expect(prChecksTone(counts)).toBe("none");
    expect(formatPrChecksValue(counts)).toBe("None reported");
  });
});
