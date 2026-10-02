import { useEffect, useLayoutEffect } from "react";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * The behaviour a master-detail settings page (`settings-master-detail.tsx`)
 * needs once it draws one AREA at a time: a search result has to pick its
 * area before its row can be seen, and a newly picked area starts at its top.
 * Shared by Settings ▸ Layout and Settings ▸ Appearance.
 */

/**
 * Marks the scroll box of one area of a master-detail page - the element
 * `useSettingsAreaStartsAtTop` rewinds. Spread onto the area's body.
 */
export const SETTINGS_AREA_BODY_PROPS = {
  "data-settings-area-body": "",
} as const;

/**
 * A Settings search result for a row on a master-detail page, taken to its
 * area.
 *
 * The reveal watcher (`useSettingsAnchorReveal`) finds the anchor and flashes
 * it, and polls until it can - but only the picked area is visible, so the row
 * cannot be seen until this has picked its area. `areaForAnchor` answers
 * `null` for an anchor that is on no area, or not this page's; it is an effect
 * dependency, so pass a module-level function.
 */
export function useSettingsAnchorArea<Area extends string>(
  section: SettingsSectionId,
  areaForAnchor: (anchor: string) => Area | null,
  setArea: (area: Area) => void,
): void {
  const pendingReveal = useSettingsSearchStore((state) => state.pendingReveal);
  useEffect(() => {
    if (pendingReveal === null || pendingReveal.section !== section) return;
    if (pendingReveal.anchor === null) return;
    const target = areaForAnchor(pendingReveal.anchor);
    if (target !== null) setArea(target);
  }, [pendingReveal, section, areaForAnchor, setArea]);
}

/**
 * A newly picked area starts at its top, as a newly picked provider does.
 *
 * Each area keeps its own scroll box while hidden, so without this one left
 * scrolled far down would come back there. A layout effect, so it runs before
 * a search reveal scrolls the same box to a row.
 */
export function useSettingsAreaStartsAtTop(
  root: { current: HTMLDivElement | null },
  area: string,
): void {
  useLayoutEffect(() => {
    const body = root.current?.querySelector(
      '[role="tabpanel"]:not([hidden]) [data-settings-area-body]',
    );
    if (body !== null && body !== undefined) body.scrollTop = 0;
  }, [root, area]);
}
