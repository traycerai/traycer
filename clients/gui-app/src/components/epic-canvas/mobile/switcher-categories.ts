import {
  getLeftPanelDefinition,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import { visibleRailPanelIds, type RailEntry } from "@/lib/layout/rail";
import {
  type LeftPanelId,
  type PanelVisibilityOverrideById,
} from "@/lib/left-panel-ids";

/**
 * The mobile "Switch tab" sheet's categories: the desktop rail's panels, read
 * off the same layout the rail draws from, since a phone has no rail.
 *
 * - `bar` is the scrollable chip row, in the user's rail order (the order
 *   Settings > Layout > Sidebar lists and drags).
 * - `more` is every panel the user explicitly turned off there, in the same
 *   order, behind the bar's trailing "More" entry. On the desktop that switch
 *   removes the icon; on the phone it only demotes the chip.
 *
 * Every panel is always on one of the two. The desktop rail's presence rules
 * (Pull requests only with PRs, Comments only with a revealed thread) do NOT
 * apply here: `Auto` reads as shown. The sheet is the only surface that lists
 * a panel's contents on a phone - the PR panel's host picker is how PRs on
 * another machine are discovered, and an anchor tap lands on Comments - so a
 * panel that came and went with presence would strand the user.
 *
 * Identity (title + icon) is the registry's, so mobile never forks the copy.
 */
export interface SwitcherCategories {
  readonly bar: ReadonlyArray<LeftPanelMetadataDefinition>;
  readonly more: ReadonlyArray<LeftPanelMetadataDefinition>;
}

export function switcherCategories(
  rail: ReadonlyArray<RailEntry>,
  visibilityOverrideById: PanelVisibilityOverrideById,
): SwitcherCategories {
  const bar: LeftPanelMetadataDefinition[] = [];
  const more: LeftPanelMetadataDefinition[] = [];
  for (const panelId of visibleRailPanelIds(rail, () => true)) {
    const definition = getLeftPanelDefinition(panelId);
    if (visibilityOverrideById[panelId] === false) more.push(definition);
    else bar.push(definition);
  }
  return { bar, more };
}

/**
 * Mobile-only display-label overrides for the category tabs. The desktop
 * `LEFT_PANEL_DEFINITIONS` title stays "Agents" (id `chats`); on mobile the user
 * wants the tab labelled "Chats" to correlate directly with what it lists. The
 * id (persisted selection, store key) is untouched - only the label changes.
 */
const MOBILE_SWITCHER_TITLE_OVERRIDES: Partial<Record<LeftPanelId, string>> = {
  chats: "Chats",
};

export function switcherCategoryTitle(
  definition: LeftPanelMetadataDefinition,
): string {
  return MOBILE_SWITCHER_TITLE_OVERRIDES[definition.id] ?? definition.title;
}
