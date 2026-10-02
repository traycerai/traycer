import { describe, expect, it } from "vitest";
import {
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

  it("resolves Auto to Detailed only in the status bar", () => {
    const detailed = TABLE.filter(
      ([placement]) => resolveReadingDensity("auto", placement) === "detailed",
    ).map(([placement]) => placement);

    expect(detailed).toEqual(["status-bar"]);
  });
});
