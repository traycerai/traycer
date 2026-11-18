import type { NotificationChimeEventType } from "@/lib/notifications/notification-chime";

/**
 * Whether each kind of notification interrupts on this computer: the in-app
 * toast while the app is in front, the OS notification while it is not, and
 * the chime that goes with them. One switch governs all three. It never
 * decides whether a notification is RECORDED - a kind that is off still lists
 * in the bell and counts as unread.
 *
 * Kept by this app, not by a host: which kinds interrupt is a fact about the
 * screen in front of the person, and every host they use reaches the same one.
 */
export type NotificationNotifyByEvent = Readonly<
  Record<NotificationChimeEventType, boolean>
>;

/** Info is quiet unless asked for; the other three interrupt. */
export const DEFAULT_NOTIFICATION_NOTIFY: NotificationNotifyByEvent = {
  needs_action: true,
  failure: true,
  done: true,
  info: false,
};
