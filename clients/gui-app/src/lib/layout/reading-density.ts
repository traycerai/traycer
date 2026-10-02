/**
 * How much a usage or resource reading says at the spot it is placed.
 *
 * The user picks `ReadingDensity` per item; the placement decides what `auto`
 * means. A tab strip never trades tab space for readings unless the user asks,
 * so `auto` is `compact` in every strip and `detailed` only in the status bar.
 * Every consumer picks its form through `resolveReadingDensity` and nowhere
 * else, so the table below is the one place that answer lives.
 */

import {
  barPlacement,
  type BarRegionId,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";

export type ReadingDensity = "auto" | "compact" | "detailed";

export type ResolvedReadingDensity = "compact" | "detailed";

/**
 * Where a reading is drawn. The phone header is not one: it always draws the
 * glyph (`MobileAppHeader`), so it has no density to resolve.
 */
export type ReadingPlacement =
  | "top-strip"
  | "side-strip"
  | "side-strip-collapsed"
  | "status-bar";

export function resolveReadingDensity(
  density: ReadingDensity,
  placement: ReadingPlacement,
): ResolvedReadingDensity {
  // A collapsed side strip has no room for rows, whatever the user chose.
  if (placement === "side-strip-collapsed") return "compact";
  if (density !== "auto") return density;
  return placement === "status-bar" ? "detailed" : "compact";
}

/**
 * The placement a reading's Density resolves at, from where the arrangement
 * puts it. A side strip reads as expanded here: whether it is collapsed is the
 * strip's own live state, which only the strip itself draws from.
 */
export function readingPlacement(
  arrangement: LayoutArrangement,
  region: BarRegionId,
): ReadingPlacement {
  if (barPlacement(arrangement, region).host === "status-bar") {
    return "status-bar";
  }
  return arrangement.tabStripPlacement === "top" ? "top-strip" : "side-strip";
}

export function resolvedReadingDensity(
  density: ReadingDensity,
  arrangement: LayoutArrangement,
  region: BarRegionId,
): ResolvedReadingDensity {
  return resolveReadingDensity(density, readingPlacement(arrangement, region));
}

/**
 * Whether Usage limits' Reading style is drawn at all: only the status bar's
 * Detailed form has calm profiles to style. The top strip's Detailed form and
 * the side strip's rows already show the percent.
 */
export function readingStyleApplies(
  density: ReadingDensity,
  arrangement: LayoutArrangement,
): boolean {
  const placement = readingPlacement(arrangement, "usageLimits");
  return (
    placement === "status-bar" &&
    resolveReadingDensity(density, placement) === "detailed"
  );
}

/** CPU percent at or above which every CPU reading uses the warning color. */
export const CPU_WARNING_PERCENT = 85;
