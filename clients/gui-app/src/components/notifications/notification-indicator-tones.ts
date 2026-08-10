import {
  MessageSquareCheck,
  MessageSquareWarning,
  MessageSquareX,
  type LucideIcon,
} from "lucide-react";
import { MessageSquareQuestionMark } from "@/components/notifications/message-square-question-mark";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type {
  HostNotificationKind,
  HostNotificationSeverity,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * Shared presentation metadata for the notification status tiers. Both the
 * per-row `NotificationIndicatorIcon` and the chat tree's descendant-status
 * rollup badge derive their glyph and color from these, so the two surfaces
 * cannot drift apart. `attentionTone` also encodes the attention-tier
 * precedence (failure > interview > approval); the running and unread-done
 * tiers slot in below it at each consumer per its activity signal.
 */
export type NotificationStatusKind =
  | "failure"
  | "interview"
  | "interview-resolved"
  | "approval"
  | "approval-resolved"
  | "done";

export interface IndicatorTone {
  readonly testId: NotificationStatusKind;
  readonly title: string;
  readonly className: string;
  readonly Icon: LucideIcon;
}

/**
 * Source of truth for agent-work status presentation. Chat rows, canvas tabs,
 * descendant rollups, and notification-center rows all resolve through this
 * registry, so adding a future surface cannot silently invent another glyph
 * or color for the same state.
 */
export const NOTIFICATION_STATUS_TONES: Readonly<
  Record<NotificationStatusKind, IndicatorTone>
> = {
  done: {
    testId: "done",
    title: "Task completed",
    // `--success-foreground` (unlike `--success`) is verified >=3:1 against
    // every preset's `--background`/`--canvas` - see index.css.
    className: "text-success-foreground",
    Icon: MessageSquareCheck,
  },
  failure: {
    testId: "failure",
    title: "Task needs attention",
    className: "text-destructive",
    Icon: MessageSquareX,
  },
  interview: {
    testId: "interview",
    title: "Task waiting for your interview response",
    className: "text-warning-foreground",
    Icon: MessageSquareQuestionMark,
  },
  "interview-resolved": {
    testId: "interview-resolved",
    title: "Question resolved",
    className: "text-warning-foreground",
    Icon: MessageSquareQuestionMark,
  },
  approval: {
    testId: "approval",
    title: "Task waiting for your approval",
    className: "text-warning-foreground",
    Icon: MessageSquareWarning,
  },
  "approval-resolved": {
    testId: "approval-resolved",
    title: "Approval resolved",
    className: "text-warning-foreground",
    Icon: MessageSquareWarning,
  },
};

export const DONE_TONE = NOTIFICATION_STATUS_TONES.done;
export const FAILURE_TONE = NOTIFICATION_STATUS_TONES.failure;
export const INTERVIEW_TONE = NOTIFICATION_STATUS_TONES.interview;
export const APPROVAL_TONE = NOTIFICATION_STATUS_TONES.approval;
export const RESOLVED_INTERVIEW_TONE =
  NOTIFICATION_STATUS_TONES["interview-resolved"];
export const RESOLVED_APPROVAL_TONE =
  NOTIFICATION_STATUS_TONES["approval-resolved"];

export function attentionTone(
  state: NotificationIndicatorState,
): IndicatorTone | null {
  if (state.unreadFailure) return FAILURE_TONE;
  if (state.pendingInterview) return INTERVIEW_TONE;
  if (state.pendingApproval) return APPROVAL_TONE;
  return null;
}

interface NotificationFeedToneInput {
  readonly severity: HostNotificationSeverity;
  readonly hostKind: HostNotificationKind | null;
  readonly resolvedAt: number | null;
}

/** Resolve a durable feed event onto the same semantic status vocabulary used
 * by live chat surfaces. A prompt's kind and disposition are independent:
 * resolution changes its tooltip without replacing its approval/question
 * glyph or color with the generic completion presentation. Informational
 * events have no agent-work tone and stay on the notification center's neutral
 * fallback. */
export function notificationFeedTone(
  input: NotificationFeedToneInput,
): IndicatorTone | null {
  if (input.severity === "failure") return FAILURE_TONE;
  if (input.severity === "done") return DONE_TONE;
  if (input.severity !== "needs_action") return null;
  if (input.hostKind === "interview.requested") {
    return input.resolvedAt === null ? INTERVIEW_TONE : RESOLVED_INTERVIEW_TONE;
  }
  if (input.hostKind === "approval.requested") {
    return input.resolvedAt === null ? APPROVAL_TONE : RESOLVED_APPROVAL_TONE;
  }
  return null;
}
