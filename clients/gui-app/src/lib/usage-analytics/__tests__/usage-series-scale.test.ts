import { describe, expect, it } from "vitest";
import {
  buildUsageSeriesScale,
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

  it("caps at sixteen slots and folds the rest into Other, never generating a 17th hue", () => {
    const seventeenKeys = [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
    ];
    const scale = buildUsageSeriesScale(seventeenKeys);
    expect(scale.order).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      USAGE_SERIES_OTHER_KEY,
    ]);
    expect(scale.colorVar("p")).toBe("var(--usage-series-16)");
    expect(scale.colorVar("q")).toBe("var(--usage-series-other)");
    expect(scale.labelFor(USAGE_SERIES_OTHER_KEY)).toBe("Other");
  });

  it("does not fold when there are exactly sixteen keys", () => {
    const sixteen = [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
    ];
    const scale = buildUsageSeriesScale(sixteen);
    expect(scale.order).toEqual(sixteen);
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
