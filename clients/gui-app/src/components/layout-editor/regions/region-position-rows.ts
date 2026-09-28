import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import {
  asBarRegionId,
  barPlacement,
  DEFAULT_ARRANGEMENT,
  withBarHost,
  withBarSide,
  type EdgeSide,
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
 * The same question asked of ONE axis, which is what a row's own dot and its
 * own revert read (L-133).
 *
 * The two bar readings have two Position rows each since L-156 - a bar and an
 * end of it - and a revert belongs to the row it sits on: putting the side
 * back must not also drag the reading to the other bar.
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
 * question the index's changed dot asks (I-17).
 *
 * The same three row shapes as {@link positionRowChanged}, and the same answer
 * for two of them: a host and a side are already this region's own. An order
 * group is where the two questions part. {@link positionRowChanged} asks about
 * the GROUP, which is right for the revert that puts the whole group back and
 * wrong for a dot: all nine rail regions share the `rail` group, and the
 * shipped panel grouping arrives as dividers (L-49), so one carried divider
 * lit every sidebar row before the user had touched anything.
 *
 * MOVED here means: this region's index among its group's REGIONS, counted
 * with the rail's dividers left out, differs from its index in
 * `DEFAULT_ARRANGEMENT`. Dividers are left out because adding one shifts every
 * entry below it without moving any panel relative to its neighbours - the
 * boundary moved, not the row. A region its group no longer holds is absent
 * from both lists and has not moved.
 */
export function regionPositionMoved(
  snapshot: LayoutSnapshot,
  region: RegionId,
): boolean {
  const arrangement = snapshot.arrangement;
  return positionRows(region).some((row) => {
    switch (row.kind) {
      case "position-host":
      case "position-side":
        return rowChanged(arrangement, region, row);
      case "position-order":
        return (
          groupRegionIds(arrangement, row.group).indexOf(region) !==
          groupRegionIds(DEFAULT_ARRANGEMENT, row.group).indexOf(region)
        );
    }
  });
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
        barPlacement(arrangement, bar).host !==
        barPlacement(DEFAULT_ARRANGEMENT, bar).host
      );
    }
    case "position-side":
      return (
        edgeSideFor(region, arrangement) !==
        edgeSideFor(region, DEFAULT_ARRANGEMENT)
      );
    case "position-order":
      return reorderedGroups(arrangement).includes(row.group);
  }
}

/** One order group's REGIONS, in order; the rail's non-region entries out. */
function groupRegionIds(
  arrangement: LayoutArrangement,
  group: OrderGroupId,
): ReadonlyArray<string> {
  switch (group) {
    case "dock":
      return arrangement.dock;
    case "toolbarLeft":
      return arrangement.toolbarLeft;
    case "toolbarRight":
      return arrangement.toolbarRight;
    case "usageProviders":
      return arrangement.usageProviders;
    case "rail":
      return arrangement.rail.flatMap((entry) =>
        entry.kind === "panel" ? [entry.id] : [],
      );
  }
}

/**
 * Every Position row of this region put back, leaving every other region
 * alone: the whole-region revert the page offers on a row (L-95).
 */
export function revertPositionRow(
  arrangement: LayoutArrangement,
  region: RegionId,
): LayoutArrangement {
  return positionRows(region).reduce(
    (current, row): LayoutArrangement => revertRow(current, region, row),
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
      return withBarHost(
        arrangement,
        bar,
        barPlacement(DEFAULT_ARRANGEMENT, bar).host,
      );
    }
    case "position-side": {
      const bar = asBarRegionId(region);
      if (bar === null) {
        return { ...arrangement, minimapSide: DEFAULT_ARRANGEMENT.minimapSide };
      }
      return withBarSide(
        arrangement,
        bar,
        barPlacement(DEFAULT_ARRANGEMENT, bar).side,
      );
    }
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

/** The side a `position-side` region is drawn on: a bar's end, or the minimap's. */
function edgeSideFor(
  region: RegionId,
  arrangement: LayoutArrangement,
): EdgeSide {
  const bar = asBarRegionId(region);
  return bar === null
    ? arrangement.minimapSide
    : barPlacement(arrangement, bar).side;
}

function revertOrderGroup(
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
