/**
 * Which archived agents a panel still shows, and why.
 *
 * Hiding archived rows is not a bare flag. In the default unarchived view the
 * sidebar REVEALS an archived chat that is open, working, or unread - hiding a
 * row the user is actively looking at, or one that is asking for attention,
 * would lose the thing it is asking about. That pairing is the rule, so it
 * lives in one place and every surface offering the "Show" facet gets it whole
 * rather than reimplementing the easy half.
 *
 * The candidate list is the CALLER's, because each surface knows which rows it
 * renders; what it must not decide for itself is which of those survive.
 */
import { useMemo } from "react";
import {
  useEpicAgentActivityTiers,
  useEpicTreeIndex,
  type AgentActivityTier,
} from "@/lib/epic-selectors";
import {
  APPROVAL_TONE,
  attentionTone,
  FAILURE_TONE,
  FORK_TONE,
  INTERVIEW_TONE,
  terminalFailureTone,
} from "@/components/notifications/notification-indicator-tones";
import {
  selectNotificationIndicatorState,
  type NotificationIndicatorState,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useOpenTileContentIds } from "@/stores/epics/canvas/store";
import {
  CHAT_ARCHIVE_VISIBILITY,
  useChatArchiveVisibility,
} from "@/stores/epics/left-panel-store";
import {
  revealArchiveHiddenIds,
  useSidebarArchiveHiddenIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";

const EMPTY_ALWAYS_VISIBLE_IDS: ReadonlyArray<string> = [];

export type ChatDescendantStatusKind =
  | "failure"
  | "fork"
  | "interview"
  | "approval"
  | "running"
  | "background"
  | "done"
  | "terminal-failure";

/** The ladder kind an activity tier occupies. */
export function activityTierKind(
  tier: AgentActivityTier,
): ChatDescendantStatusKind {
  return tier === "turn" ? "running" : "background";
}

/**
 * The single tier a descendant chat is counted under - its own highest. The
 * attention precedence goes through the shared `attentionTone`, so
 * failure > interview > approval lives in exactly one place.
 */
export function chatDescendantKind(
  indicatorState: NotificationIndicatorState,
  tier: AgentActivityTier | undefined,
): ChatDescendantStatusKind | null {
  const tone = attentionTone(indicatorState);
  if (tone === FAILURE_TONE) return "failure";
  if (tone === FORK_TONE) return "fork";
  if (tone === INTERVIEW_TONE) return "interview";
  if (tone === APPROVAL_TONE) return "approval";
  // Terminal failure is demoted only for the exact chat's own glyph, where a
  // newer live turn/Done is a stronger statement of current state. Once this
  // chat is rolled into a collapsed parent it is a distinct failed child and
  // must remain attention-priority over a sibling's activity or completion.
  if (terminalFailureTone(indicatorState, "gui") !== null) return "failure";
  if (tier !== undefined) return activityTierKind(tier);
  if (indicatorState.unreadDone) return "done";
  return null;
}

/**
 * The archived ids a panel should hide, after the reveal exception.
 *
 * `chatIds` are the rows the caller renders; `notificationIndicators` is the
 * indicator state it already subscribes to - passed in rather than re-fetched
 * so the reveal reads exactly what the rows read.
 */
export function useChatArchiveHiddenIds(args: {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatIds: ReadonlyArray<string>;
  readonly notificationIndicators: SurfaceNotificationIndicators;
}): ReadonlySet<string> {
  const { epicId, tabId, chatIds, notificationIndicators } = args;
  const archiveVisibility = useChatArchiveVisibility(epicId);
  const baseArchiveHiddenIds = useSidebarArchiveHiddenIds(epicId);
  const tree = useEpicTreeIndex();
  const openTileContentIds = useOpenTileContentIds(tabId);
  const activityTiers = useEpicAgentActivityTiers();
  const appLocalNotificationRows = useAppLocalNotificationsStore(
    (state) => state.byId,
  );
  const alwaysVisibleIds = useMemo((): ReadonlyArray<string> => {
    if (archiveVisibility !== CHAT_ARCHIVE_VISIBILITY.Unarchived) {
      return EMPTY_ALWAYS_VISIBLE_IDS;
    }
    return chatIds.filter((chatId) => {
      if (openTileContentIds.has(chatId)) return true;
      const indicatorState = selectNotificationIndicatorState(
        { byId: appLocalNotificationRows },
        { epicId, chatId },
        null,
        notificationIndicators,
      );
      return (
        chatDescendantKind(indicatorState, activityTiers.get(chatId)) !== null
      );
    });
  }, [
    activityTiers,
    appLocalNotificationRows,
    archiveVisibility,
    epicId,
    chatIds,
    notificationIndicators,
    openTileContentIds,
  ]);
  return useMemo(
    () => revealArchiveHiddenIds(baseArchiveHiddenIds, alwaysVisibleIds, tree),
    [baseArchiveHiddenIds, alwaysVisibleIds, tree],
  );
}
