import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { tabWaitingReason } from "../tab-waiting";
import {
  APPROVAL_TONE,
  DONE_TONE,
  FAILURE_TONE,
  INTERVIEW_TONE,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";

/**
 * The one state on a task that needs the user (D5), drawn as the tile's
 * corner badge and as the meter's attention pip. Running is not here: the
 * meter carries it.
 */
export type RailBadgeKind = "approval" | "reply" | "failed" | "unread";

/**
 * The tone each badge draws, the notification feed's own. A task spans GUI
 * and TUI agents, so its failure takes the surface-neutral chat failure, as
 * the Agents tree's collapsed rollup does.
 */
export const RAIL_BADGE_TONE: Readonly<Record<RailBadgeKind, IndicatorTone>> = {
  approval: APPROVAL_TONE,
  reply: INTERVIEW_TONE,
  failed: FAILURE_TONE,
  unread: DONE_TONE,
};

/**
 * Approval and reply are one tier (both are waiting on the user); reply breaks
 * the tie, the order `tabWaitingReason` uses for a single task.
 */
const RAIL_BADGE_RANK: Readonly<Record<RailBadgeKind, number>> = {
  reply: 0,
  approval: 1,
  failed: 2,
  unread: 3,
};

/**
 * The one badge a task shows: waiting (as approval or reply), then failed,
 * then unread-done. The indicator already carries a warm session's waiting
 * reason (`withWaitingIndicator`). When both a question and an approval are
 * pending the reply wins, the order `tabWaitingReason` uses. A pending fork is
 * the host's own business and gives no badge.
 */
export function railBadgeOf(
  indicator: NotificationIndicatorState,
): RailBadgeKind | null {
  const waiting = tabWaitingReason(indicator, null);
  if (waiting !== null) return waiting;
  if (indicator.unreadFailure) return "failed";
  if (indicator.unreadDone) return "unread";
  return null;
}

/** The strongest badge among several, as a collapsed group shows it. */
export function worstRailBadge(
  badges: ReadonlyArray<RailBadgeKind | null>,
): RailBadgeKind | null {
  let worst: RailBadgeKind | null = null;
  for (const badge of badges) {
    if (badge === null) continue;
    if (worst === null || RAIL_BADGE_RANK[badge] < RAIL_BADGE_RANK[worst]) {
      worst = badge;
    }
  }
  return worst;
}
