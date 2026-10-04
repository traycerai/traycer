import { useBarPlacements } from "@/lib/layout-overrides";
import {
  BAR_REGION_IDS,
  type BarRegionId,
} from "@/lib/layout/layout-arrangement";

/**
 * The readings placed in the tab strip, in the model's own order (usage first).
 *
 * A tab strip has no side: the top strip draws these before History, and the
 * side strip draws them above its account row, so the saved `usageSide` /
 * `resourceSide` are read only by the status bar.
 */
export function useStripReadingRegions(): ReadonlyArray<BarRegionId> {
  const placements = useBarPlacements();
  return BAR_REGION_IDS.filter(
    (region) => placements[region].host === "header",
  );
}
