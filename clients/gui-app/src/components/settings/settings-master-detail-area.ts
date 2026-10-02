import { useEffect, useLayoutEffect } from "react";
import { useActiveSetupGuideStep } from "@/components/settings/use-active-setup-guide-step";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * The behaviour a master-detail settings page (`settings-master-detail.tsx`)
 * needs once it draws one AREA at a time: a search result or a setup guide
 * step has to pick its area before its target can be seen, and a newly picked
 * area starts at its top. Shared by Settings ▸ Layout and Settings ▸
 * Appearance.
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
 * Names the area a panel draws, so a control inside it can be traced back to
 * the area that has to be picked for it to be seen. Spread onto the area's
 * panel.
 */
export function settingsAreaPanelProps(area: string): {
  readonly "data-settings-area": string;
} {
  return { "data-settings-area": area };
}

/**
 * A setup guide step that points into an area, taken to that area.
 *
 * The guide's coachmark draws only once its target is on screen
 * (`useGuideTarget`), and Continue navigates between settings sections, never
 * inside one. So a step whose target sits in an area that is not picked would
 * leave the guide with no card and no way on. Every area stays mounted, so the
 * target is in the DOM and its panel says which area it is.
 *
 * Runs when the step changes, not when the area does: a person who picks
 * another area mid-step is left there, and the card returns with the area.
 *
 * A reveal that is armed for a row of this page outranks the step. A guide
 * stays active while Settings is closed, so the page can mount with both: a
 * step left on one area, and a search result or a link that has just asked
 * for another. The person asked for that one a moment ago; the guide was
 * left behind. Read from the store rather than subscribed to, so the step
 * does not take the area back once the reveal is spent.
 * `areaForId` is an effect dependency, so pass a module-level function.
 */
export function useSettingsGuideArea<Area extends string>(
  section: SettingsSectionId,
  root: { current: HTMLDivElement | null },
  areaForId: (id: string) => Area | null,
  setArea: (area: Area) => void,
): void {
  const guide = useActiveSetupGuideStep();
  const selector =
    guide !== null && guide.step.section === section
      ? guide.step.selector
      : null;
  useEffect(() => {
    if (selector === null) return;
    const reveal = useSettingsSearchStore.getState().pendingReveal;
    if (reveal !== null && reveal.section === section && reveal.anchor !== null)
      return;
    const id = root.current
      ?.querySelector(selector)
      ?.closest("[data-settings-area]")
      ?.getAttribute("data-settings-area");
    if (id === null || id === undefined) return;
    const target = areaForId(id);
    if (target !== null) setArea(target);
  }, [selector, section, root, areaForId, setArea]);
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
