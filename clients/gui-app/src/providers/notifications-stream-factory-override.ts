import type { NotificationsStreamClientFactory } from "@/stores/notifications/notifications-store";

/**
 * Production builds NotificationsStreamClient. Tests inject a mock.
 */
let streamClientFactoryOverride: NotificationsStreamClientFactory | null = null;

export function __setNotificationsStreamFactoryForTests(
  factory: NotificationsStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getNotificationsStreamFactoryOverride(): NotificationsStreamClientFactory | null {
  return streamClientFactoryOverride;
}
