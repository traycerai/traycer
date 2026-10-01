import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import type { RailVisibility } from "@/lib/layout/layout-values";
import { isAutoRailRegionId, RAIL_REGION_IDS } from "@/lib/layout/rail";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import type { RailRegionId, RegionId } from "@/lib/layout/region-id";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * Every write an editor session makes, each as ONE recorded gesture.
 *
 * One module above both surfaces rather than one per surface: the inspector's
 * rows and the canvas's drag change the same two things, and a write that
 * skipped `recordGesture` would be a change the undo stack never saw -
 * invisible until someone pressed undo and the wrong thing moved. It is also
 * what makes a whole drag one step: the reflow is paint, and the drop calls
 * `writeArrangement` (`lib/layout/arrangement-gestures.ts`) exactly once -
 * import it from there directly rather than through this module.
 */

export function isRailRegionId(id: RegionId): id is RailRegionId {
  return RAIL_REGION_IDS.some((candidate) => candidate === id);
}

/**
 * What a region's `shown` becomes when it is turned ON.
 *
 * Pull requests and Comments go to `auto` rather than `shown`: their presence
 * rule is the default, and pinning one open is a separate answer the Auto /
 * Shown / Hidden control gives (L-47). One function because two surfaces turn a
 * region on - the form and a right-click quick verb - and a second copy of this
 * rule would be a panel that comes back pinned from one of them.
 */
export function regionShownOnValue(regionId: RegionId): RailVisibility {
  return isAutoRailRegionId(regionId) ? "auto" : "shown";
}

/** The one rule for turning a region on or off, Auto panels included (L-47). */
export function setRegionShown(regionId: RegionId, next: boolean): void {
  const shown = next ? regionShownOnValue(regionId) : "hidden";
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().setRegionValues(regionId, { shown });
  });
}

/**
 * One provider on or off the strip, as one recorded gesture.
 *
 * Here beside the other writes rather than in the dock's provider screen: the
 * page's provider row asks the same question with a segmented control instead
 * of a switch (L-121), and the CONTROL is the hosts' to differ on while the
 * write is not.
 */
export function toggleHiddenProvider(
  providerId: RateLimitProviderId,
  arrangement: LayoutArrangement,
  shown: boolean,
): void {
  const hiddenProviders = shown
    ? arrangement.hiddenProviders.filter((entry) => entry !== providerId)
    : [...arrangement.hiddenProviders, providerId];
  writeArrangement({ ...arrangement, hiddenProviders });
}
