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
 * horizontally-scrollable tab bar. Curated to Agents (`chats`), Artifacts, File
 * tree, Git diff, Pull requests and Terminals; Sharing is excluded and Comments
 * live inside the artifact tile. `pull-requests` sits directly after `git-diff`
 * exactly as it does in the desktop rail, so the two surfaces read in the same
 * order. Identity (title + icon) is reused verbatim from
 * `LEFT_PANEL_DEFINITIONS` so mobile never forks the category copy.
 */
const CURATED_ORDER: readonly LeftPanelId[] = [
  "chats",
  "artifacts",
  "file-tree",
  "git-diff",
  "pull-requests",
  "terminals",
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
 * visible in the registry, and Comments - the one remaining context-dependent
 * panel - is not in the set. The empty override map keeps the switcher on each
 * panel's own rule: the rail's show/hide context menu is a desktop affordance,
 * and the phone switcher's category set is curated here rather than by it.
 */
function switcherAvailability(
  hasPullRequests: boolean,
): LeftPanelAvailabilityContext {
  return {
    commentsPanelRevealed: false,
    hasActiveCommentableArtifact: false,
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
 * leaving the sheet with no matching tab. Two ways that happens: a category
 * mobile never curates (e.g. Sharing, selected on desktop), and `pull-requests`
 * persisted from an epic that has since stopped reporting any PR.
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
