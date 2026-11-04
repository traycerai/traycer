import type { HostNotificationSeverity } from "@traycer/protocol/host/notifications/contracts";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
  type NotificationEvent,
} from "@traycer/protocol/notifications/notification-entry";

/**
 * The severity of a Notifications-room (collaboration) event. Being given a
 * task is the one collaboration event the person has to learn about to act
 * on - nothing else tells them the task exists - so an invitation is
 * attention-grade and counts on the bell like a host prompt does. Every other
 * collaboration event is news about a task they already have, and stays
 * informational: a quiet dot and a row in Recent.
 */
export function severityForGlobalEvent(
  event: NotificationEvent,
): HostNotificationSeverity {
  return event.kind === NOTIFICATION_EVENT_TYPES.INVITED
    ? "needs_action"
    : "info";
}

/** Whether a room entry counts toward the bell's attention count. */
export function isUnreadGlobalAttention(entry: NotificationEntry): boolean {
  return (
    entry.readAt === null &&
    severityForGlobalEvent(entry.event) === "needs_action"
  );
}
