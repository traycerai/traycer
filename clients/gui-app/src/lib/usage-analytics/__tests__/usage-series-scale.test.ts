import { describe, expect, it } from "vitest";
import {
  buildUsageSeriesScale,
  harnessIdsByFirstAppearance,
  USAGE_SERIES_OTHER_KEY,
} from "@/lib/usage-analytics/usage-series-scale";

describe("buildUsageSeriesScale", () => {
  it("assigns slots in the given order, never resorted", () => {
    const scale = buildUsageSeriesScale(["codex", "claude", "opencode"]);
    expect(scale.order).toEqual(["codex", "claude", "opencode"]);
    expect(scale.colorVar("codex")).toBe("var(--usage-series-1)");
    expect(scale.colorVar("claude")).toBe("var(--usage-series-2)");
    expect(scale.colorVar("opencode")).toBe("var(--usage-series-3)");
  });

  it("caps at eight slots and folds the rest into Other, never generating a 9th hue", () => {
    const nineHarnesses = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const scale = buildUsageSeriesScale(nineHarnesses);
    expect(scale.order).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      USAGE_SERIES_OTHER_KEY,
    ]);
    expect(scale.colorVar("i")).toBe("var(--usage-series-other)");
    expect(scale.labelFor(USAGE_SERIES_OTHER_KEY)).toBe("Other");
  });

  it("does not fold when there are exactly eight harnesses", () => {
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const scale = buildUsageSeriesScale(eight);
    expect(scale.order).toEqual(eight);
    expect(scale.order).not.toContain(USAGE_SERIES_OTHER_KEY);
  });

  it("labelFor returns the raw harness id (no invented display-name catalog)", () => {
    const scale = buildUsageSeriesScale(["claude"]);
    expect(scale.labelFor("claude")).toBe("claude");
  });

  it("an unrecognized key (not in the built order) falls back to the Other color", () => {
    const scale = buildUsageSeriesScale(["claude"]);
    expect(scale.colorVar("some-unknown-id")).toBe("var(--usage-series-other)");
  });
});

describe("harnessIdsByFirstAppearance", () => {
  it("orders harnesses by their earliest day, not alphabetically or by input order", () => {
    const order = harnessIdsByFirstAppearance([
      { day: "2026-08-03", harnessId: "codex" },
      { day: "2026-08-01", harnessId: "claude" },
      { day: "2026-08-02", harnessId: "opencode" },
      { day: "2026-08-01", harnessId: "codex" },
    ]);
    expect(order).toEqual(["claude", "codex", "opencode"]);
  });

  it("de-duplicates repeated harnesses", () => {
    const order = harnessIdsByFirstAppearance([
      { day: "2026-08-01", harnessId: "claude" },
      { day: "2026-08-02", harnessId: "claude" },
    ]);
    expect(order).toEqual(["claude"]);
  });
});
