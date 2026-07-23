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
 * benign context only exists to honour each definition's `isVisible()` contract
 * (Comments/Sharing - the only context-dependent panels - are not in the set).
 */
const SWITCHER_AVAILABILITY: LeftPanelAvailabilityContext = {
  commentsPanelRevealed: false,
  hasActiveCommentableArtifact: false,
};

export function visibleSwitcherCategoryDefs(): ReadonlyArray<LeftPanelMetadataDefinition> {
  return MOBILE_SWITCHER_CATEGORY_DEFS.filter((definition) =>
    definition.isVisible(SWITCHER_AVAILABILITY),
  );
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
