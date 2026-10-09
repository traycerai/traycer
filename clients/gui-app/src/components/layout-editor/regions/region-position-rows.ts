import { readingSpot } from "@/components/layout-editor/regions/reading-placement";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import {
  asBarRegionId,
  barPlacement,
  DEFAULT_ARRANGEMENT,
  withBarHost,
  withBarSide,
  type LayoutArrangement,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import { reorderedGroups } from "@/lib/layout/layout-diff";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * A region's Position row measured against, and put back to, the shipped
 * arrangement: a preset has no opinion about position, so the DEFAULT
 * arrangement is the baseline for its dot and its revert.
 */

/**
 * Whether this region's Position row differs from the shipped arrangement.
 *
 * `false` for a region with no Position row, which includes every region whose
 * only row is Size or Style.
 */
export function positionRowChanged(
  snapshot: LayoutSnapshot,
  region: RegionId,
): boolean {
  return positionRows(region).some((row) =>
    rowChanged(snapshot.arrangement, region, row),
  );
}

/**
 * The same question asked of ONE row kind, which is what a row's own dot and
 * its own revert read (L-133).
 */
export function positionAxisChanged(
  snapshot: LayoutSnapshot,
  region: RegionId,
  axis: PositionRowKind,
): boolean {
  return positionRows(region).some(
    (row) => row.kind === axis && rowChanged(snapshot.arrangement, region, row),
  );
}

/**
 * Whether THIS region alone sits somewhere other than where it shipped - the
 * question a row's changed dot and its revert ask (I-17, T2).
 *
 * Its host and its side, never its place in an order group. An order is a
 * fact about the LIST, not about one row in it: one drag shifts the index of
 * every row below it, so a per-row reading lit many rows, and each one's
 * revert put the whole group back - order, dividers and stacks. The list's
 * own header owns that dot and that revert, and nothing else does.
 */
export function regionPositionMoved(
  snapshot: LayoutSnapshot,
  region: RegionId,
): boolean {
  return positionRows(region).some(
    (row) =>
      row.kind !== "position-order" &&
      rowChanged(snapshot.arrangement, region, row),
  );
}

/** One Position row measured against the shipped arrangement, by axis. */
function rowChanged(
  arrangement: LayoutArrangement,
  region: RegionId,
  row: PositionRow,
): boolean {
  switch (row.kind) {
    case "position-host": {
      const bar = asBarRegionId(region);
      if (bar === null) return false;
      return (
        readingSpot(barPlacement(arrangement, bar)) !==
        readingSpot(barPlacement(DEFAULT_ARRANGEMENT, bar))
      );
    }
    case "position-side":
      return arrangement.minimapSide !== DEFAULT_ARRANGEMENT.minimapSide;
    case "position-order":
      return reorderedGroups(arrangement).includes(row.group);
  }
}

/**
 * This region's host and side put back, leaving every other region alone: the
 * whole-region revert the page offers on a row (L-95). Its place in an order
 * group stays, for the reason {@link regionPositionMoved} gives; the list's
 * header puts the order back ({@link revertOrderGroup}).
 */
export function revertPositionRow(
  arrangement: LayoutArrangement,
  region: RegionId,
): LayoutArrangement {
  return positionRows(region).reduce(
    (current, row): LayoutArrangement =>
      row.kind === "position-order" ? current : revertRow(current, region, row),
    arrangement,
  );
}

/** ONE axis put back, which is what the row carrying it reverts (L-156). */
export function revertPositionAxis(
  arrangement: LayoutArrangement,
  region: RegionId,
  axis: PositionRowKind,
): LayoutArrangement {
  return positionRows(region).reduce(
    (current, row): LayoutArrangement =>
      row.kind === axis ? revertRow(current, region, row) : current,
    arrangement,
  );
}

function revertRow(
  arrangement: LayoutArrangement,
  region: RegionId,
  row: PositionRow,
): LayoutArrangement {
  switch (row.kind) {
    case "position-host": {
      const bar = asBarRegionId(region);
      if (bar === null) return arrangement;
      // Both axes: the one Location row writes a bar and, in the status bar, an end.
      return withBarSide(
        withBarHost(
          arrangement,
          bar,
          barPlacement(DEFAULT_ARRANGEMENT, bar).host,
        ),
        bar,
        barPlacement(DEFAULT_ARRANGEMENT, bar).side,
      );
    }
    case "position-side":
      return { ...arrangement, minimapSide: DEFAULT_ARRANGEMENT.minimapSide };
    case "position-order":
      return revertOrderGroup(arrangement, row.group);
  }
}

export type PositionRowKind =
  | "position-host"
  | "position-side"
  | "position-order";

type PositionRow =
  | { readonly kind: "position-host" }
  | { readonly kind: "position-side" }
  | { readonly kind: "position-order"; readonly group: OrderGroupId };

function positionRows(region: RegionId): ReadonlyArray<PositionRow> {
  return regionFacts(region).rows.flatMap((row): PositionRow[] => {
    if (row.kind === "position-host") return [{ kind: "position-host" }];
    if (row.kind === "position-side") return [{ kind: "position-side" }];
    if (row.kind === "position-order") {
      return [{ kind: "position-order", group: row.group }];
    }
    return [];
  });
}

/**
 * One order group back to its shipped order - for the rail, its dividers and
 * stacks with it. What a list header's revert writes, and nothing else does.
 */
export function revertOrderGroup(
  arrangement: LayoutArrangement,
  group: OrderGroupId,
): LayoutArrangement {
  switch (group) {
    case "dock":
      return { ...arrangement, dock: DEFAULT_ARRANGEMENT.dock };
    case "toolbarLeft":
      return { ...arrangement, toolbarLeft: DEFAULT_ARRANGEMENT.toolbarLeft };
    case "toolbarRight":
      return { ...arrangement, toolbarRight: DEFAULT_ARRANGEMENT.toolbarRight };
    case "rail":
      return { ...arrangement, rail: DEFAULT_ARRANGEMENT.rail };
    case "usageProviders":
      return {
        ...arrangement,
        usageProviders: DEFAULT_ARRANGEMENT.usageProviders,
      };
  }
}
