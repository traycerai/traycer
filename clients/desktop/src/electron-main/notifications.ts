import { Notification } from "electron";
import { log } from "./app/logger";

export const NOTIFICATION_REPLACE_TTL_MS = 60_000;
const MAX_REPLACEABLE_NOTIFICATIONS = 100;
const MAX_DELIVERED_NOTIFICATION_KEYS = 5_000;
const replaceableNotifications = new Map<string, Notification>();
const deliveredNotificationKeys = new Set<string>();

export interface NativeNotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly replaceKey: string | null;
  readonly deliveryKey: string | null;
  readonly onClick: (() => void) | null;
}

/**
 * Shows a native notification. A replacement key groups notifications that
 * describe the same entity: a newer notification closes and re-alerts over
 * the prior one instead of leaving a stack in the OS notification center.
 */
export function showNativeNotification(
  options: NativeNotificationOptions,
): void {
  if (
    options.deliveryKey !== null &&
    deliveredNotificationKeys.has(options.deliveryKey)
  ) {
    return;
  }
  if (!Notification.isSupported()) {
    log.warn("[notifications] not supported on this platform");
    rememberDeliveredNotificationKey(options.deliveryKey);
    return;
  }

  const notification = new Notification({
    title: options.title,
    body: options.body,
  });
  const replaceKey = options.replaceKey;

  if (replaceKey !== null) {
    const priorNotification = replaceableNotifications.get(replaceKey);
    if (priorNotification !== undefined) {
      priorNotification.close();
    }
    evictReplaceableNotifications();
    replaceableNotifications.set(replaceKey, notification);
    notification.on("close", () => {
      deleteReplacementIfCurrent(replaceKey, notification);
    });
    notification.on("click", () => {
      deleteReplacementIfCurrent(replaceKey, notification);
    });
    setTimeout(() => {
      if (replaceableNotifications.get(replaceKey) !== notification) return;
      replaceableNotifications.delete(replaceKey);
    }, NOTIFICATION_REPLACE_TTL_MS);
  }

  if (options.onClick !== null) {
    notification.on("click", options.onClick);
  }
  notification.show();
  rememberDeliveredNotificationKey(options.deliveryKey);
}

function rememberDeliveredNotificationKey(deliveryKey: string | null): void {
  if (deliveryKey === null || deliveredNotificationKeys.has(deliveryKey)) {
    return;
  }
  while (deliveredNotificationKeys.size >= MAX_DELIVERED_NOTIFICATION_KEYS) {
    const oldest = deliveredNotificationKeys.values().next();
    if (oldest.done) return;
    deliveredNotificationKeys.delete(oldest.value);
  }
  deliveredNotificationKeys.add(deliveryKey);
}

/**
 * Releases bookkeeping for platforms that do not report notification closes.
 * It deliberately does not dismiss native notifications; once an entry ages
 * out, a later same-key notification may stack rather than replace it.
 */
function evictReplaceableNotifications(): void {
  while (replaceableNotifications.size >= MAX_REPLACEABLE_NOTIFICATIONS) {
    const oldest = replaceableNotifications.entries().next();
    if (oldest.done) return;
    const [replaceKey, notification] = oldest.value;
    if (replaceableNotifications.get(replaceKey) !== notification) continue;
    replaceableNotifications.delete(replaceKey);
  }
}

function deleteReplacementIfCurrent(
  replaceKey: string,
  notification: Notification,
): void {
  if (replaceableNotifications.get(replaceKey) === notification) {
    replaceableNotifications.delete(replaceKey);
  }
}

/**
 * Shows a plain title/body notification whose only interaction is a body click.
 * Used where there is no command to route - the click handler runs directly
 * (e.g. bring the app forward).
 */
export function showSimpleNotification(
  title: string,
  body: string,
  onClick: () => void,
): void {
  showNativeNotification({
    title,
    body,
    replaceKey: null,
    deliveryKey: null,
    onClick,
  });
}

/**
 * Logs cold-start notification activations (clicks/buttons/replies that
 * launched the app from background). The static `Notification.handleActivation`
 * hook ships in the Electron typedefs ahead of the runtime in some 42.x
 * point releases - guard the call so the absence is a no-op log rather
 * than an unhandled rejection at app startup. Without a `toastXml`
 * integration to embed routing metadata in the Windows activation string,
 * the handler currently only logs; future work can decode
 * `details.arguments` to route commands.
 */
export function installNotificationActivationHandler(): void {
  if (typeof Notification.handleActivation !== "function") {
    log.info(
      "[notifications] handleActivation not available in this Electron build",
    );
    return;
  }
  Notification.handleActivation((details) => {
    log.info("[notifications] cold-start activation", {
      type: details.type,
      actionIndex: details.actionIndex,
      hasReply: details.reply !== undefined,
    });
  });
}
