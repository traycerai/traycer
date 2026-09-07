import { BrowserWindow, Notification } from "electron";
import type { DesktopNotificationShowOutcome } from "../ipc-contracts/notification-types";
import { log } from "./app/logger";

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
  readonly onForegroundSuppressed: (() => void) | null;
}

/** The returned outcome names the delivery decision so the calling renderer can tell "someone is presenting this" from "nothing was and nothing will". */
export function showNativeNotification(
  options: NativeNotificationOptions,
): DesktopNotificationShowOutcome {
  if (
    options.deliveryKey !== null &&
    deliveredNotificationKeys.has(options.deliveryKey)
  ) {
    return "duplicate";
  }
  if (
    BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.isFocused(),
    )
  ) {
    closeReplacement(options.replaceKey);
    options.onForegroundSuppressed?.();
    // Foreground suppression is an intentional delivery outcome. Remember an
    // exact key so another renderer cannot replay the same event after focus
    // changes; the suppression callback relays it to the foreground renderer.
    rememberDeliveredNotificationKey(options.deliveryKey);
    return "presented";
  }
  if (!Notification.isSupported()) {
    log.warn("[notifications] not supported on this platform");
    rememberDeliveredNotificationKey(options.deliveryKey);
    return "undeliverable";
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
  }

  if (options.onClick !== null) {
    notification.on("click", options.onClick);
  }
  notification.show();
  rememberDeliveredNotificationKey(options.deliveryKey);
  return "presented";
}

function closeReplacement(replaceKey: string | null): void {
  if (replaceKey === null) return;
  const priorNotification = replaceableNotifications.get(replaceKey);
  if (priorNotification === undefined) return;
  replaceableNotifications.delete(replaceKey);
  priorNotification.close();
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

/** Bounds bookkeeping for platforms that do not report notification closes. */
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
    onForegroundSuppressed: null,
  });
}

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
