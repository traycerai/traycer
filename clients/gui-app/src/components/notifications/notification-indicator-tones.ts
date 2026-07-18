import {
  MessageSquareCheck,
  MessageSquareWarning,
  MessageSquareX,
  type LucideIcon,
} from "lucide-react";
import { MessageSquareQuestionMark } from "@/components/notifications/message-square-question-mark";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

/**
 * Shared presentation metadata for the notification status tiers. Both the
 * per-row `NotificationIndicatorIcon` and the chat tree's descendant-status
 * rollup badge derive their glyph and color from these, so the two surfaces
 * cannot drift apart. `attentionTone` also encodes the attention-tier
 * precedence (failure > interview > approval); the running and unread-done
 * tiers slot in below it at each consumer per its activity signal.
 */
export interface IndicatorTone {
  readonly testId: "failure" | "interview" | "approval" | "done";
  readonly title: string;
  readonly className: string;
  readonly Icon: LucideIcon;
}

export const DONE_TONE: IndicatorTone = {
  testId: "done",
  title: "Task completed",
  // `--success-foreground` (unlike `--success`) is verified >=3:1 against
  // every preset's `--background`/`--canvas` - see index.css.
  className: "text-success-foreground",
  Icon: MessageSquareCheck,
};

export const FAILURE_TONE: IndicatorTone = {
  testId: "failure",
  title: "Task needs attention",
  className: "text-destructive",
  Icon: MessageSquareX,
};

export const INTERVIEW_TONE: IndicatorTone = {
  testId: "interview",
  title: "Task waiting for your interview response",
  className: "text-warning-foreground",
  Icon: MessageSquareQuestionMark,
};

export const APPROVAL_TONE: IndicatorTone = {
  testId: "approval",
  title: "Task waiting for your approval",
  className: "text-warning-foreground",
  Icon: MessageSquareWarning,
};

export function attentionTone(
  state: NotificationIndicatorState,
): IndicatorTone | null {
  if (state.unreadFailure) return FAILURE_TONE;
  if (state.pendingInterview) return INTERVIEW_TONE;
  if (state.pendingApproval) return APPROVAL_TONE;
  return null;
}
