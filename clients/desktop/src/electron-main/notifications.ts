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

/**
 * Shows a native notification when every Traycer window is unfocused. A
 * replacement key groups notifications that describe the same entity: a newer
 * notification closes and re-alerts over the prior one instead of leaving a
 * stack in the OS notification center.
 *
 * The returned outcome names the delivery decision so the calling renderer
 * can tell "someone is presenting this" from "nothing was and nothing will".
 * The delivery-key ledger makes `undeliverable` a single-winner outcome: the
 * first window to report an occurrence on an unsupported platform hears it,
 * every later window hears `duplicate` - which is what lets exactly one
 * renderer own the fallback cue without re-creating the per-window fan-out.
 */
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

/**
 * Bounds bookkeeping for platforms that do not report notification closes.
 * It deliberately does not dismiss native notifications; once capacity is
 * reached, a later same-key notification may stack rather than replace the
 * oldest forgotten entry.
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
    onForegroundSuppressed: null,
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
