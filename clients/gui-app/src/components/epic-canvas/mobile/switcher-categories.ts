import {
  LEFT_PANEL_DEFINITIONS,
  type LeftPanelAvailabilityContext,
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
 * The context each curated definition's `isAutoVisible()` is judged against.
 * Only PR presence varies: every other curated category is unconditionally
 * visible on the bar. The empty override map keeps the switcher on each panel's
 * own rule: the rail's show/hide context menu is a desktop affordance, and the
 * phone switcher's category set is curated here rather than by it.
 *
 * Comments answers the registry's two reveal gates affirmatively because the
 * two surfaces have opposite constraints. The desktop rail is a fixed strip
 * alongside the canvas, so it can afford to hold the tab back until an artifact
 * tile reveals it. The phone sheet is the ONLY route to a thread list, a
 * permalink or a reply composer - so a tab that came and went with the shown
 * tile would leave a tap on a thread anchor with nowhere to land. The tab is
 * permanent here, and the body names the condition when the shown tile is not
 * an artifact.
 */
function switcherAvailability(
  hasPullRequests: boolean,
): LeftPanelAvailabilityContext {
  return {
    commentsPanelRevealed: true,
    hasActiveCommentableArtifact: true,
    hasPullRequests,
    visibilityOverrideById: {},
  };
}

/**
 * The categories the sheet shows right now. `hasPullRequests` is the same
 * presence signal the desktop rail gates its Pull Requests icon on, so an epic
 * with no PRs gets no PR tab - identical to desktop, where the panel earns no
 * rail slot.
 */
export function visibleSwitcherCategoryDefs(
  hasPullRequests: boolean,
): ReadonlyArray<LeftPanelMetadataDefinition> {
  const availability = switcherAvailability(hasPullRequests);
  return CURATED_CATEGORY_DEFS.filter((definition) =>
    definition.isAutoVisible(availability),
  );
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

/**
 * Clamp a persisted active left-panel id to the categories currently on the
 * bar, so a selection with no tab behind it falls back to Agents rather than
 * leaving the sheet with no matching tab. `pull-requests` is the case that
 * reaches it: persisted from an epic that has since stopped reporting any PR,
 * or against a host that does not serve the PR stream.
 */
export function clampToSwitcherCategory(
  id: LeftPanelId,
  hasPullRequests: boolean,
): LeftPanelId {
  const visible = visibleSwitcherCategoryDefs(hasPullRequests);
  return visible.some((definition) => definition.id === id)
    ? id
    : DEFAULT_LEFT_PANEL_ID;
}

/** Membership in the curated set, independent of present-moment visibility. */
export function isSwitcherCategory(value: string): value is LeftPanelId {
  return CURATED_CATEGORY_IDS.some((id) => id === value);
}
