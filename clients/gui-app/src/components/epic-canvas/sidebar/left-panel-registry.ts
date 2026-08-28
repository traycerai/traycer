import {
  Files,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Globe2,
  MessageSquareText,
  MessagesSquare,
  Terminal,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_LEFT_PANEL_ID,
  type LeftPanelId,
  type PanelVisibilityOverrideById,
} from "@/stores/epics/left-panel-store";

export interface LeftPanelAvailabilityContext {
  readonly commentsPanelRevealed: boolean;
  readonly hasActiveCommentableArtifact: boolean;
  /** At least one PR was discovered from this epic's chats. */
  readonly hasPullRequests: boolean;
  /**
   * Explicit show/hide the user chose from the rail context menu. Wins over
   * `isAutoVisible`; an absent entry means the panel follows its own rule.
   */
  readonly visibilityOverrideById: PanelVisibilityOverrideById;
}

/** Props for the panel `Body` and `Actions` slots in the registry. */
export interface LeftPanelSlotProps {
  readonly epicId: string;
  readonly tabId: string;
}

export interface LeftPanelMetadataDefinition {
  readonly id: LeftPanelId;
  readonly title: string;
  readonly icon: LucideIcon;
  /**
   * Whether the panel earns a rail slot on its own. Most panels are
   * unconditional; `pull-requests` and `comments` are presence-gated. This is
   * the DEFAULT, not the answer: the user's override is applied on top of it by
   * {@link isLeftPanelVisible}, which is what every render path calls.
   */
  readonly isAutoVisible: (context: LeftPanelAvailabilityContext) => boolean;
  /**
   * Muted note shown beside this panel in the rail context menu while the user
   * is forcing it visible against `isAutoVisible` - it explains up front why
   * the panel they just revealed can be empty. `null` for panels that are
   * always auto-visible, where the case cannot arise.
   */
  readonly forcedOnHint: string | null;
  /**
   * Whether this panel's header row can be traded for a search input while
   * searching (see `panel-header-search-store`). Panels that opt out never
   * render the portal target, so their header is always the standard row.
   */
  readonly supportsHeaderSearch: boolean;
}

export const LEFT_PANEL_DEFINITIONS: ReadonlyArray<LeftPanelMetadataDefinition> =
  [
    {
      // `id` is an internal panel identifier on the compatibility boundary
      // (persisted layout, selection state, command ids) - only the product
      // copy moves to the Agent model.
      id: "chats",
      title: "Agents",
      icon: MessagesSquare,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: true,
    },
    {
      id: "terminals",
      title: "Terminals",
      icon: Terminal,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: false,
    },
    {
      id: "browsers",
      title: "Browsers",
      icon: Globe2,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: true,
    },
    {
      id: "artifacts",
      title: "Artifacts",
      icon: Files,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: true,
    },
    {
      id: "git-diff",
      title: "Git Diff",
      icon: GitBranch,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: false,
    },
    {
      // Presence-gated like `comments`: an epic whose chats produced no PR
      // gets no rail slot for one. Checking it in the rail context menu is the
      // escape hatch for a user who wants the panel there before any PR
      // exists (see `isLeftPanelVisible`).
      id: "pull-requests",
      title: "Pull Requests",
      icon: GitPullRequest,
      isAutoVisible: (context) => context.hasPullRequests,
      forcedOnHint: "No PRs yet",
      supportsHeaderSearch: false,
    },
    {
      id: "file-tree",
      title: "File Tree",
      icon: FolderTree,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: false,
    },
    {
      id: "sharing",
      title: "Sharing",
      icon: UserPlus,
      isAutoVisible: () => true,
      forcedOnHint: null,
      supportsHeaderSearch: false,
    },
    {
      id: "comments",
      title: "Comments",
      icon: MessageSquareText,
      isAutoVisible: (context) =>
        context.commentsPanelRevealed && context.hasActiveCommentableArtifact,
      forcedOnHint: "Needs an open artifact",
      supportsHeaderSearch: false,
    },
  ];

/**
 * The one visibility answer every render path uses: the user's explicit choice
 * if they made one, the panel's own rule otherwise.
 */
export function isLeftPanelVisible(
  definition: LeftPanelMetadataDefinition,
  context: LeftPanelAvailabilityContext,
): boolean {
  const override = context.visibilityOverrideById[definition.id];
  if (override !== undefined) return override;
  return definition.isAutoVisible(context);
}

/**
 * Which of the visible rail groups owns `activePanelId` - or, when that panel
 * is not currently visible, the group the sidebar body falls back to.
 *
 * Rail and body both resolve through here so hiding the active panel cannot
 * leave them disagreeing: the icon that lights up is the one whose body is on
 * screen. `null` means nothing is visible at all, which the body answers with
 * the default panel.
 */
export function resolveActiveVisibleGroupIndex(
  visibleGroupPanelIds: ReadonlyArray<ReadonlyArray<LeftPanelId>>,
  activePanelId: LeftPanelId,
): number | null {
  const activeIndex = visibleGroupPanelIds.findIndex((panelIds) =>
    panelIds.includes(activePanelId),
  );
  if (activeIndex >= 0) return activeIndex;
  const defaultIndex = visibleGroupPanelIds.findIndex((panelIds) =>
    panelIds.includes(DEFAULT_LEFT_PANEL_ID),
  );
  if (defaultIndex >= 0) return defaultIndex;
  return visibleGroupPanelIds.length === 0 ? null : 0;
}
