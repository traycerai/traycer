import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_TOP_LEVEL_SURFACES,
  advanceTopLevelSurfaceRecency,
  retainedTopLevelSurfaceKeys,
} from "@/stores/tabs/top-level-surface-retention";

describe("retainedTopLevelSurfaceKeys (pure)", () => {
  it("retains every key that is active or already in recency, under the cap", () => {
    const retained = retainedTopLevelSurfaceKeys(
      ["a", "b", "c"],
      ["c"],
      ["a", "b"],
    );
    expect(new Set(retained)).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not retain an available key that has never been active or recorded into recency", () => {
    const retained = retainedTopLevelSurfaceKeys(["a", "b", "c"], ["c"], []);
    expect(retained).toEqual(["c"]);
  });

  it("retains a brand-new key immediately once it is active, even with no recency history", () => {
    const retained = retainedTopLevelSurfaceKeys(["a", "new"], ["new"], ["a"]);
    expect(new Set(retained)).toEqual(new Set(["a", "new"]));
  });

  it("pins the active key first and evicts the least-recently-active over the cap", () => {
    const available = ["0", "1", "2", "3", "4", "5"];
    const retained = retainedTopLevelSurfaceKeys(
      available,
      ["5"],
      ["4", "3", "2", "1", "0"],
    );
    expect(retained).not.toContain("0");
    expect(retained).toContain("5");
    expect(retained.length).toBe(MAX_RETAINED_TOP_LEVEL_SURFACES);
  });

  it("drops keys no longer available even if still in recency", () => {
    const retained = retainedTopLevelSurfaceKeys(["a"], ["a"], ["a", "stale"]);
    expect(retained).toEqual(["a"]);
  });

  it("does not let an unavailable active key consume a retention slot", () => {
    const available = ["0", "1", "2", "3", "4", "5"];
    const retained = retainedTopLevelSurfaceKeys(
      available,
      ["stale-active"],
      ["5", "4", "3", "2", "1", "0"],
    );

    expect(retained).toHaveLength(MAX_RETAINED_TOP_LEVEL_SURFACES);
    expect(retained).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("applies one global cap across mixed-kind keys, not a per-kind cap", () => {
    const available = [
      "epic:old",
      "draft:1",
      "draft:2",
      "draft:3",
      "draft:4",
      "epic:new",
    ];
    const retained = retainedTopLevelSurfaceKeys(
      available,
      ["epic:new"],
      ["draft:4", "draft:3", "draft:2", "draft:1", "epic:old"],
    );
    expect(retained).not.toContain("epic:old");
    expect(retained).toContain("epic:new");
    expect(retained.length).toBe(MAX_RETAINED_TOP_LEVEL_SURFACES);
  });
});

describe("advanceTopLevelSurfaceRecency (pure)", () => {
  it("moves active keys to the front, preserving the relative order of the rest", () => {
    const next = advanceTopLevelSurfaceRecency(["b"], ["a", "b", "c"]);
    expect(next).toEqual(["b", "a", "c"]);
  });

  it("is idempotent for repeated calls with the same active keys", () => {
    const once = advanceTopLevelSurfaceRecency(["b"], ["a", "b", "c"]);
    const twice = advanceTopLevelSurfaceRecency(["b"], once);
    expect(twice).toEqual(once);
  });

  it("appends a brand-new active key without dropping prior recency", () => {
    const next = advanceTopLevelSurfaceRecency(["new"], ["a", "b"]);
    expect(next).toEqual(["new", "a", "b"]);
  });
});
