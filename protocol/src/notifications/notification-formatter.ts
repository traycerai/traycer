import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEvent,
} from "./notification-entry";

/**
 * Formats a notification event into a human-readable string.
 * Pass `epicTitle: undefined` for the generic copy; a non-empty string
 * produces title-aware copy.
 */
export function formatNotification(
  event: NotificationEvent,
  epicTitle: string | undefined,
): string {
  const target =
    epicTitle !== undefined && epicTitle.length > 0
      ? `epic "${epicTitle}"`
      : "an epic";
  switch (event.kind) {
    case NOTIFICATION_EVENT_TYPES.INVITED:
      return `${event.actorName} invited you to ${target}`;
    case NOTIFICATION_EVENT_TYPES.ROLE_CHANGED:
      return `${event.actorName} changed your role in ${target} to "${event.newRole}"`;
    case NOTIFICATION_EVENT_TYPES.REVOKED:
      return `${event.actorName} removed your access of ${target}`;
    case NOTIFICATION_EVENT_TYPES.THREAD_CREATED:
      return `${event.actorName} mentioned you in a comment on ${target}`;
    case NOTIFICATION_EVENT_TYPES.COMMENT_ADDED:
      return `${event.actorName} replied in a comment thread on ${target}`;
    case NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED:
      return `${event.actorName} resolved a comment thread on ${target}`;
    case NOTIFICATION_EVENT_TYPES.THREAD_DELETED:
      return `${event.actorName} deleted a comment thread on ${target}`;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Extracts the epicId from any NotificationEvent variant.
 */
export function getEpicIdFromEvent(event: NotificationEvent): string {
  return event.epicId;
}
