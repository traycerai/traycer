import type { EpicWaitingReason } from "@/hooks/epic/use-epic-activity-status";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

/**
 * What a tab is waiting on the user for, from either source: the notification
 * bits (lit while the prompt notification is unresolved and not cleared) or
 * the warm chat session's gate facts (true while the agent is blocked, which
 * also covers a cleared or superseded notification and a prompt with no
 * notification yet). A reply outranks an approval, the order `attentionTone`
 * uses.
 */
export function tabWaitingReason(
  indicator: NotificationIndicatorState,
  session: EpicWaitingReason | null,
): EpicWaitingReason | null {
  if (indicator.pendingInterview || session === "reply") return "reply";
  if (indicator.pendingApproval || session === "approval") return "approval";
  return null;
}

/**
 * ORs a waiting reason into the indicator's matching bit, so every reader of
 * the indicator draws the waiting glyph. Returns `indicator` itself when the
 * bit is already lit or there is no reason.
 */
export function withWaitingIndicator(
  indicator: NotificationIndicatorState,
  reason: EpicWaitingReason | null,
): NotificationIndicatorState {
  if (reason === "reply") {
    return indicator.pendingInterview
      ? indicator
      : { ...indicator, pendingInterview: true };
  }
  if (reason === "approval") {
    return indicator.pendingApproval
      ? indicator
      : { ...indicator, pendingApproval: true };
  }
  return indicator;
}

/** The waiting chip's one word (S-26). */
export function sideTabWaitingLabel(
  reason: EpicWaitingReason | null,
): "Approve" | "Reply" | null {
  if (reason === "reply") return "Reply";
  if (reason === "approval") return "Approve";
  return null;
}
