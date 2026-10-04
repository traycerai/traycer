import { LAYOUT_REGION_LIST } from "@/components/layout-editor/regions/region-facts";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import {
  positionRowChanged,
  regionPositionMoved,
  revertPositionRow,
} from "@/components/layout-editor/regions/region-position-rows";
import { SURFACE_ORDER_GROUPS } from "@/components/layout-editor/regions/surface-groups";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  layoutChanges,
  mobileFooterChanged,
  pinnedFieldOrderChanged,
  regionChangedKeys,
  reorderedGroups,
  revertLayoutChange,
  sidebarSideChanged,
  sideStripViewChanged,
  tabStripPlacementChanged,
  usageProvidersChanged,
} from "@/lib/layout/layout-diff";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * One surface of the layout measured against what shipped: the changed dot on
 * a Settings ▸ Layout area (H2).
 *
 * A surface is its regions - their values against the last-applied preset, and their
 * Position rows against the shipped arrangement, the same two questions a
 * region row's own dot asks - plus the fields that belong to the surface and
 * to no region, each compared by the predicate that knows its meaning (a
 * provider on Automatic is no change, a divider's id is no move). A value kept
 * in another region's bag but set by this surface's row counts here and not
 * there ({@link isOffRegionValue}, T4).
 *
 * Which profiles the usage popover shows is left out on purpose: it is picked
 * where it is drawn, not on this page. `resetLayout` still covers it.
 */

/**
 * Values kept in one region's bag but set by an AREA row (T4): the region's
 * own dot and revert leave them out, and the area that draws the row counts
 * them. Here rather than beside the diff (`lib/layout/layout-diff.ts`),
 * because which surface owns a row is the form's fact, not the layout's.
 *
 * - The readings on agent rows sit beside the Resource monitor's values
 *   because the monitor's Metrics choice says WHICH readings (L-174), but the
 *   switch is a Sidebar row (G7).
 * - Toolbar style sits in the Model bag, but it styles every toolbar button,
 *   so it is a Composer area row (C3).
 */
const OFF_REGION_VALUES: ReadonlyArray<{
  readonly region: RegionId;
  readonly key: string;
  readonly surface: SurfaceGroupId;
}> = [
  { region: "resourceMonitor", key: "agentRows", surface: "sidebar" },
  { region: "model", key: "toolbarStyle", surface: "composer" },
];

export function isOffRegionValue(region: RegionId, key: string): boolean {
  return OFF_REGION_VALUES.some(
    (value) => value.region === region && value.key === key,
  );
}

/** Whether a region's OWN values moved, leaving out its off-region ones. */
function regionOwnValuesChanged(
  snapshot: LayoutSnapshot,
  region: RegionId,
): boolean {
  return regionChangedKeys(snapshot, region).some(
    (key) => !isOffRegionValue(region, key),
  );
}

/** Whether any area row of `surface` that writes another region's bag moved. */
function offRegionValuesChanged(
  snapshot: LayoutSnapshot,
  surface: SurfaceGroupId,
): boolean {
  return OFF_REGION_VALUES.some(
    (value) =>
      value.surface === surface &&
      regionChangedKeys(snapshot, value.region).includes(value.key),
  );
}

/** Whether anything on `surface` differs from what shipped. */
export function surfaceChanged(
  snapshot: LayoutSnapshot,
  surface: SurfaceGroupId,
): boolean {
  return (
    surfaceRegionIds(surface).some(
      (region) =>
        regionOwnValuesChanged(snapshot, region) ||
        positionRowChanged(snapshot, region),
    ) ||
    reorderedGroups(snapshot.arrangement).some((group) =>
      SURFACE_ORDER_GROUPS[surface].includes(group),
    ) ||
    SURFACE_FIELDS_CHANGED[surface](snapshot.arrangement) ||
    offRegionValuesChanged(snapshot, surface)
  );
}

function surfaceRegionIds(surface: SurfaceGroupId): ReadonlyArray<RegionId> {
  return LAYOUT_REGION_LIST.filter((region) => region.surface === surface).map(
    (region) => region.id,
  );
}

const SURFACE_FIELDS_CHANGED: Readonly<
  Record<SurfaceGroupId, (arrangement: LayoutArrangement) => boolean>
> = {
  topBar: (arrangement) =>
    tabStripPlacementChanged(arrangement, DEFAULT_ARRANGEMENT) ||
    sideStripViewChanged(arrangement, DEFAULT_ARRANGEMENT) ||
    arrangement.taskTabLayout !== DEFAULT_ARRANGEMENT.taskTabLayout,
  sidebar: (arrangement) =>
    sidebarSideChanged(arrangement, DEFAULT_ARRANGEMENT),
  chat: (arrangement) =>
    arrangement.minimapSide !== DEFAULT_ARRANGEMENT.minimapSide ||
    arrangement.readingWidth !== DEFAULT_ARRANGEMENT.readingWidth ||
    arrangement.wideReadingWidthPx !== DEFAULT_ARRANGEMENT.wideReadingWidthPx ||
    pinnedFieldOrderChanged(arrangement, DEFAULT_ARRANGEMENT),
  composer: () => false,
  statusBar: (arrangement) =>
    usageProvidersChanged(arrangement) || mobileFooterChanged(arrangement),
};

/**
 * Whether one region's row differs from what shipped, which is what its dot
 * draws: its own values, its host and side, for Usage limits which providers
 * its Profiles list hides (P-6, P-7), and for Context usage the order its
 * Breakdown rows were dragged into (C2).
 *
 * Never a LIST order (T2): a row's place in a list is the list header's dot.
 * So neither a dragged rail panel nor a reordered Profiles list lights a row.
 * The breakdown order is not one of those - it is a detail of this row, set
 * inside its own disclosure. A provider's limits are not counted either: they
 * are edited in Settings ▸ Providers.
 */
export function regionRowChanged(
  snapshot: LayoutSnapshot,
  regionId: RegionId,
): boolean {
  return (
    regionOwnValuesChanged(snapshot, regionId) ||
    regionPositionMoved(snapshot, regionId) ||
    (regionId === "usageLimits" &&
      snapshot.arrangement.hiddenProviders.length > 0) ||
    (regionId === "contextUsage" &&
      pinnedFieldOrderChanged(snapshot.arrangement, DEFAULT_ARRANGEMENT))
  );
}

/**
 * Everything {@link regionRowChanged} measures, put back as ONE step: the
 * row's own values, its host and side, for Usage limits its hidden providers,
 * and for Context usage its breakdown order. A list order stays (the list
 * header's revert), a value another surface's row sets stays (T4), and so
 * does each provider's limits.
 */
export function revertedRegionRow(
  snapshot: LayoutSnapshot,
  regionId: RegionId,
): LayoutSnapshot {
  const reverted = layoutChanges(snapshot)
    .styles.filter(
      (change) =>
        change.region === regionId && !isOffRegionValue(regionId, change.key),
    )
    .reduce((current, change) => revertLayoutChange(current, change), snapshot);
  const placed = revertPositionRow(reverted.arrangement, regionId);
  switch (regionId) {
    case "usageLimits":
      return {
        ...reverted,
        arrangement: {
          ...placed,
          hiddenProviders: DEFAULT_ARRANGEMENT.hiddenProviders,
        },
      };
    case "contextUsage":
      return revertLayoutChange(
        { ...reverted, arrangement: placed },
        { kind: "pinnedFieldOrder" },
      );
    default:
      return { ...reverted, arrangement: placed };
  }
}
