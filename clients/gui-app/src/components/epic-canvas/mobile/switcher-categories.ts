import {
  LEFT_PANEL_DEFINITIONS,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  DEFAULT_LEFT_PANEL_ID,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";

/**
 * The mobile "Switch tab" sheet exposes the desktop left-panel categories as a
 * horizontally-scrollable tab bar: Agents (`chats`), Artifacts, File tree, Git
 * diff, Pull requests, Terminals, Browsers, Sharing and Comments.
 *
 * The bar's order is its OWN, not the rail's - the rail runs chats, terminals,
 * browsers, artifacts, git-diff, pull-requests, file-tree - and only the local
 * adjacencies are shared: `pull-requests` sits directly after `git-diff`, and
 * `browsers` directly after `terminals`, so a category is found beside the one
 * it is found beside on the desktop. Identity (title + icon) is reused verbatim
 * from `LEFT_PANEL_DEFINITIONS` so mobile never forks the category copy.
 *
 * Every panel the rail carries is on this bar. A category left off would be
 * unreachable on a phone rather than merely tidier: an agent can open a
 * terminal or a browser tab the user never asked for, and the sheet is the only
 * surface that lists them.
 */
const CURATED_ORDER: readonly LeftPanelId[] = [
  "chats",
  "artifacts",
  "file-tree",
  "git-diff",
  "pull-requests",
  "terminals",
  "browsers",
  "sharing",
  "comments",
];

const DEFINITION_BY_ID = new Map<LeftPanelId, LeftPanelMetadataDefinition>(
  LEFT_PANEL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const CURATED_CATEGORY_DEFS: ReadonlyArray<LeftPanelMetadataDefinition> =
  CURATED_ORDER.flatMap((id) => {
    const definition = DEFINITION_BY_ID.get(id);
    return definition === undefined ? [] : [definition];
  });

const CURATED_CATEGORY_IDS: ReadonlyArray<LeftPanelId> =
  CURATED_CATEGORY_DEFS.map((definition) => definition.id);

/**
 * All curated categories remain reachable on mobile. In particular, the PR
 * panel's host picker must be accessible when the canvas host has no PRs or
 * cannot serve its stream. Opening the category is what starts discovery.
 */
export function visibleSwitcherCategoryDefs(): ReadonlyArray<LeftPanelMetadataDefinition> {
  return CURATED_CATEGORY_DEFS;
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

/** Clamp a persisted desktop panel to the mobile curated categories. */
export function clampToSwitcherCategory(id: LeftPanelId): LeftPanelId {
  return CURATED_CATEGORY_IDS.includes(id) ? id : DEFAULT_LEFT_PANEL_ID;
}

/** Membership in the curated set, independent of present-moment visibility. */
export function isSwitcherCategory(value: string): value is LeftPanelId {
  return CURATED_CATEGORY_IDS.some((id) => id === value);
}
