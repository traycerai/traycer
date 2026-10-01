import { LAYOUT_REGION_LIST } from "@/components/layout-editor/regions/region-facts";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import { positionRowChanged } from "@/components/layout-editor/regions/region-position-rows";
import { SURFACE_ORDER_GROUPS } from "@/components/layout-editor/regions/surface-groups";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  mobileFooterChanged,
  regionChanged,
  reorderedGroups,
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
 * region row's own dot asks - plus the arrangement fields that belong to the
 * surface and to no region, each compared by the predicate that knows its
 * meaning (a provider on Automatic is no change, a divider's id is no move).
 *
 * Fields another surface writes are left out on purpose: which profiles the
 * usage popover shows and the context chip's pinned field order are picked
 * where they are drawn, not on this page. `resetLayout` still covers them.
 */

/** Whether anything on `surface` differs from what shipped. */
export function surfaceChanged(
  snapshot: LayoutSnapshot,
  surface: SurfaceGroupId,
): boolean {
  return (
    surfaceRegionIds(surface).some(
      (region) =>
        regionChanged(snapshot, region) || positionRowChanged(snapshot, region),
    ) ||
    reorderedGroups(snapshot.arrangement).some((group) =>
      SURFACE_ORDER_GROUPS[surface].includes(group),
    ) ||
    SURFACE_FIELDS_CHANGED[surface](snapshot.arrangement)
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
    arrangement.readingWidth !== DEFAULT_ARRANGEMENT.readingWidth,
  composer: () => false,
  statusBar: (arrangement) =>
    usageProvidersChanged(arrangement) || mobileFooterChanged(arrangement),
};
