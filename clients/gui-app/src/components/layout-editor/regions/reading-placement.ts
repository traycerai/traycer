import {
  barPlacement,
  withBarHost,
  withBarSide,
  type BarPlacement,
  type BarRegionId,
  type LayoutArrangement,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import type { ReadingPlacement } from "@/lib/layout/reading-density";

/**
 * Where a usage or resource reading sits, as the one picker says it, and what
 * its Density resolves to there.
 *
 * Stored as two fields (`host`, `side`); the picker has three spots because the
 * tab strip has no side: the activity button always sits before History, and in
 * a side strip usage comes first. The side is kept while the host is the tab
 * strip, so moving back to the status bar restores the old end.
 */

export type ReadingSpot = "tab-strip" | "status-bar-left" | "status-bar-right";

export const READING_SPOT_LABELS: Readonly<Record<ReadingSpot, string>> = {
  "tab-strip": "Tab strip",
  "status-bar-left": "Status bar left",
  "status-bar-right": "Status bar right",
};

export const READING_SPOTS: ReadonlyArray<ReadingSpot> = [
  "tab-strip",
  "status-bar-left",
  "status-bar-right",
];

export function readingSpot(placement: BarPlacement): ReadingSpot {
  if (placement.host === "header") return "tab-strip";
  return placement.side === "left" ? "status-bar-left" : "status-bar-right";
}

/** One reading moved to a spot: the host always, the side only for the status bar. */
export function withReadingSpot(
  arrangement: LayoutArrangement,
  region: BarRegionId,
  spot: ReadingSpot,
): LayoutArrangement {
  if (spot === "tab-strip") return withBarHost(arrangement, region, "header");
  return withBarSide(
    withBarHost(arrangement, region, "status-bar"),
    region,
    spot === "status-bar-left" ? "left" : "right",
  );
}

/**
 * The rows a Compact reading ignores, by the id each carries in the registry:
 * Compact draws a glyph, so it has no percent to read, no reset time to show
 * and no metrics to choose between.
 */
const COMPACT_IGNORED_ROWS: Readonly<
  Record<BarRegionId, ReadonlyArray<string>>
> = {
  usageLimits: ["amount", "reset"],
  resourceMonitor: ["metrics"],
};

export function compactIgnoredRows(region: BarRegionId): ReadonlyArray<string> {
  return COMPACT_IGNORED_ROWS[region];
}

/** What Auto resolves to at this spot, in the Density row's own words. */
export function densityDescription(
  region: BarRegionId,
  placement: ReadingPlacement,
  tabStrip: TabStripPlacement,
): string {
  const cpuOnly = region === "resourceMonitor" ? ", showing CPU only" : "";
  if (placement === "status-bar") {
    return "Auto is detailed in the status bar.";
  }
  if (tabStrip === "top") {
    return `Auto is compact in the top tab strip${cpuOnly}.`;
  }
  return region === "usageLimits"
    ? "Auto is compact in a side strip. Detailed shows one row per profile."
    : `Auto is compact in a side strip${cpuOnly}.`;
}

/** What the Location row says about sharing the spot with the other reading. */
export function locationDescription(
  region: BarRegionId,
  arrangement: LayoutArrangement,
): string {
  const other: BarRegionId =
    region === "usageLimits" ? "resourceMonitor" : "usageLimits";
  const otherName =
    other === "usageLimits" ? "Usage limits" : "Resource monitor";
  const here = barPlacement(arrangement, region);
  if (here.host !== "header") return "Pick where this reading is drawn.";
  const spot =
    arrangement.tabStripPlacement === "top"
      ? "before History"
      : "above the account";
  // Whether the two share one activity button also depends on Show and
  // Density, so the sentence names the place and the neighbour only.
  return barPlacement(arrangement, other).host === "header"
    ? `Sits ${spot}, beside ${otherName}.`
    : `Sits ${spot}.`;
}
