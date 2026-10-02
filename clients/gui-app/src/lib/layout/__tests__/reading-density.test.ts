import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  readingPlacement,
  resolveReadingDensity,
  type ReadingDensity,
  type ReadingPlacement,
  type ResolvedReadingDensity,
} from "@/lib/layout/reading-density";

// The spec's density table, one row per placement and one column per choice.
const TABLE: ReadonlyArray<
  readonly [
    ReadingPlacement,
    Readonly<Record<ReadingDensity, ResolvedReadingDensity>>,
  ]
> = [
  ["top-strip", { auto: "compact", compact: "compact", detailed: "detailed" }],
  ["side-strip", { auto: "compact", compact: "compact", detailed: "detailed" }],
  [
    "side-strip-collapsed",
    { auto: "compact", compact: "compact", detailed: "compact" },
  ],
  [
    "status-bar",
    { auto: "detailed", compact: "compact", detailed: "detailed" },
  ],
];

describe("resolveReadingDensity", () => {
  it.each(TABLE)("resolves every density at %s", (placement, expected) => {
    for (const density of ["auto", "compact", "detailed"] as const) {
      expect(resolveReadingDensity(density, placement), density).toBe(
        expected[density],
      );
    }
  });
});

describe("readingPlacement", () => {
  it("is the status bar, the top strip or a side strip", () => {
    const inStatusBar: LayoutArrangement = {
      ...DEFAULT_ARRANGEMENT,
      usageHost: "status-bar",
      tabStripPlacement: "top",
    };
    const inStrip: LayoutArrangement = { ...inStatusBar, usageHost: "header" };

    expect(readingPlacement(inStatusBar, "usageLimits")).toBe("status-bar");
    expect(readingPlacement(inStrip, "usageLimits")).toBe("top-strip");
    expect(
      readingPlacement(
        { ...inStrip, tabStripPlacement: "left" },
        "usageLimits",
      ),
    ).toBe("side-strip");
  });
});
