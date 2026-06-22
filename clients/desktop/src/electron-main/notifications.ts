import { Notification } from "electron";
import { log } from "./app/logger";
import type { HostStartupError } from "./host/host-lifecycle";
import type { MenuCommandId } from "../ipc-contracts/window-types";

interface RichNotificationButton {
  readonly text: string;
  readonly command: MenuCommandId;
}

export interface RichNotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly subtitle: string | undefined;
  readonly silent: boolean;
  readonly urgency: "normal" | "critical" | "low";
  readonly buttons: ReadonlyArray<RichNotificationButton>;
  readonly defaultClickCommand: MenuCommandId | undefined;
  readonly closeButtonText: string | undefined;
}

/**
 * Shows a notification with optional action buttons. Buttons surface as native
 * action buttons on macOS (always) and Windows (Electron 41+). On Linux only
 * the body/click path is wired; the buttons array is ignored by the OS but the
 * `defaultClickCommand` still fires on body click.
 */
export function showRichNotification(
  options: RichNotificationOptions,
  runCommand: (command: MenuCommandId) => void,
): void {
  if (!Notification.isSupported()) {
    log.warn("[notifications] not supported on this platform");
    return;
  }
  const notification = new Notification({
    title: options.title,
    body: options.body,
    subtitle: options.subtitle,
    silent: options.silent,
    urgency: options.urgency,
    closeButtonText: options.closeButtonText,
    actions: options.buttons.map((button) => ({
      type: "button",
      text: button.text,
    })),
  });
  notification.on("action", (_event, index) => {
    const button = options.buttons[index];
    if (button !== undefined) {
      runCommand(button.command);
    }
  });
  if (options.defaultClickCommand !== undefined) {
    const click = options.defaultClickCommand;
    notification.on("click", () => runCommand(click));
  }
  notification.show();
}

/**
 * Fires a critical-urgency notification when host startup fails, giving the
 * user one-click access to retry the host or open logs without hunting for
 * the tray menu. Body click defaults to opening logs.
 */
export function notifyHostError(
  err: HostStartupError,
  runCommand: (command: MenuCommandId) => void,
): void {
  showRichNotification(
    {
      title: "Traycer Host failed to start",
      body: err.message,
      subtitle: err.code,
      silent: false,
      urgency: "critical",
      buttons: [
        { text: "Retry", command: "host.restart" },
        { text: "Show Logs", command: "app.openLogs" },
      ],
      defaultClickCommand: "app.openLogs",
      closeButtonText: "Dismiss",
    },
    runCommand,
  );
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
