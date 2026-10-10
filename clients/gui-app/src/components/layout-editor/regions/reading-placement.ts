import {
  disabledBy,
  LIVE,
  liveOutsideGate,
  liveWithNote,
  strictest,
  wideLayoutRow,
  type LayoutFormContext,
  type RowDependency,
  type RowRule,
} from "@/components/layout-editor/regions/row-availability";
import {
  barPlacement,
  withBarHost,
  withBarSide,
  type BarPlacement,
  type BarRegionId,
  type LayoutArrangement,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import {
  readingPlacement,
  resolveReadingDensity,
  type ReadingPlacement,
} from "@/lib/layout/reading-density";

/**
 * Where a usage or resource reading sits, as the one picker says it, what its
 * Density resolves to there, and which of its rows that leaves doing anything.
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
 * Where a reading is drawn in THIS layout. The phone layout's footer draws
 * both readings whatever they name (`PHONE_FOOTER_PLACEMENTS`, L-162), so
 * there it is always the status bar; elsewhere the arrangement says.
 */
export function readingFormPlacement(
  context: LayoutFormContext,
  region: BarRegionId,
): ReadingPlacement {
  return context.shell.phoneLayout
    ? "status-bar"
    : readingPlacement(context.arrangement, region);
}

/** Whether the reading draws its Compact form here: a glyph and nothing else. */
function readingCompact(
  context: LayoutFormContext,
  region: BarRegionId,
): boolean {
  return (
    resolveReadingDensity(
      context.values[region].density,
      readingFormPlacement(context, region),
    ) === "compact"
  );
}

/** Why a row Compact ignores is off: it has no percent, timer or metric to show. */
export const DETAILED_ONLY_REASON = "Set Density to Detailed to use this.";

/** A row only the Detailed form reads, so it sits under Density (U3). */
function detailedOnly(region: BarRegionId): RowRule {
  return (context) =>
    readingCompact(context, region)
      ? disabledBy(DETAILED_ONLY_REASON, null)
      : LIVE;
}

/**
 * Where a reading sits: a desktop-layout row, since the phone layout's footer
 * draws both readings at fixed ends whatever this says.
 */
export const READING_LOCATION: RowDependency = {
  under: null,
  availability: (context) => wideLayoutRow(context.shell),
};

/** Reading style: only the status bar's Detailed form has calm profiles to style. */
const readingStyleRule: RowRule = (context) => {
  if (readingFormPlacement(context, "usageLimits") !== "status-bar") {
    return disabledBy("Set Location to the status bar to use this.", null);
  }
  return detailedOnly("usageLimits")(context);
};

export const READING_STYLE: RowDependency = {
  under: "density",
  availability: readingStyleRule,
};

/**
 * Percent shows: under Bar a calm profile in the status bar draws no percent,
 * so flipping Used and Remaining changes only the profiles running low and
 * the tooltip (U4) - still a live choice, said in a note.
 */
export const PERCENT_SHOWS: RowDependency = {
  under: "density",
  availability: (context) =>
    strictest([
      detailedOnly("usageLimits")(context),
      readingStyleRule(context).kind === "live" &&
      context.values.usageLimits.readingStyle === "bar"
        ? liveWithNote("With Bar, only profiles running low show a percent.")
        : LIVE,
    ]),
};

export const RESET_TIME: RowDependency = {
  under: "density",
  availability: detailedOnly("usageLimits"),
};

/**
 * Metrics: the Compact monitor is the CPU glyph alone, but agent rows read
 * the metrics picked here, all but RAM share, whatever the monitor's density
 * or Show (L-174, U2). So while they print, the row stays live, even with the
 * monitor Hidden or the phone footer off, and under Compact it says why. The
 * phone layout draws no agent rows, so there the monitor alone decides.
 */
export const METRICS: RowDependency = {
  under: "density",
  availability: (context) => {
    const compact = readingCompact(context, "resourceMonitor");
    if (
      context.values.resourceMonitor.agentRows &&
      !context.shell.phoneLayout
    ) {
      return liveOutsideGate(
        compact
          ? "Compact shows CPU only. Agent rows use the metrics picked here, except RAM share."
          : null,
      );
    }
    return compact ? disabledBy(DETAILED_ONLY_REASON, null) : LIVE;
  },
};

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
