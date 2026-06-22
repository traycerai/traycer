import type { NotificationsStreamClientFactory } from "@/stores/notifications/notifications-store";

/**
 * Test / production seam for the notifications stream. Production uses
 * `new NotificationsStreamClient({...})`; tests inject a mock so the provider
 * can be asserted without real network I/O.
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
