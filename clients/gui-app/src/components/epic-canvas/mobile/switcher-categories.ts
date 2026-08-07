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
 * horizontally-scrollable tab bar. Curated to the five settled for v1 (decision
 * table): Agents (`chats`), Artifacts, File tree, Git diff, Terminals. Sharing
 * is deferred and Comments live inside the artifact tile, so both are excluded.
 * Identity (title + icon) is reused verbatim from `LEFT_PANEL_DEFINITIONS` so
 * mobile never forks the category copy.
 */
const CURATED_ORDER: readonly LeftPanelId[] = [
  "chats",
  "artifacts",
  "file-tree",
  "git-diff",
  "terminals",
];

const DEFINITION_BY_ID = new Map<LeftPanelId, LeftPanelMetadataDefinition>(
  LEFT_PANEL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const MOBILE_SWITCHER_CATEGORY_DEFS: ReadonlyArray<LeftPanelMetadataDefinition> =
  CURATED_ORDER.flatMap((id) => {
    const definition = DEFINITION_BY_ID.get(id);
    return definition === undefined ? [] : [definition];
  });

const MOBILE_SWITCHER_CATEGORY_IDS: ReadonlyArray<LeftPanelId> =
  MOBILE_SWITCHER_CATEGORY_DEFS.map((definition) => definition.id);

/**
 * Every curated category is unconditionally visible in the registry, so this
 * benign context only exists to honour each definition's `isAutoVisible()`
 * contract (Comments/Sharing/Pull requests - the context-dependent panels - are
 * not in the set). The empty override map keeps the switcher on each panel's
 * own rule: the rail's show/hide context menu is a desktop affordance, and the
 * phone switcher's category set is curated here rather than by that menu.
 */
const SWITCHER_AVAILABILITY: LeftPanelAvailabilityContext = {
  commentsPanelRevealed: false,
  hasActiveCommentableArtifact: false,
  hasPullRequests: false,
  visibilityOverrideById: {},
};

export function visibleSwitcherCategoryDefs(): ReadonlyArray<LeftPanelMetadataDefinition> {
  return MOBILE_SWITCHER_CATEGORY_DEFS.filter((definition) =>
    definition.isAutoVisible(SWITCHER_AVAILABILITY),
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
 * Clamp a persisted active left-panel id to the mobile-curated set so a desktop
 * selection outside the five (e.g. Sharing) falls back to Agents rather than
 * leaving the sheet with no matching tab.
 */
export function clampToSwitcherCategory(id: LeftPanelId): LeftPanelId {
  return MOBILE_SWITCHER_CATEGORY_IDS.includes(id) ? id : DEFAULT_LEFT_PANEL_ID;
}

export function isSwitcherCategory(value: string): value is LeftPanelId {
  return MOBILE_SWITCHER_CATEGORY_IDS.some((id) => id === value);
}
