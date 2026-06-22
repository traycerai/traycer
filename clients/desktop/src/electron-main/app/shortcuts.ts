import { app, globalShortcut } from "electron";
import { log } from "./logger";

const SUMMON_ACCELERATOR = "CommandOrControl+Shift+Space";

export interface ShortcutTargetWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
}

/**
 * Registers a system-wide hotkey to summon (and toggle-focus) the main
 * window. Unregistered automatically on app quit so the accelerator is
 * released back to the OS. Logs but does not throw if the OS denies the
 * registration (another app already holds the same chord).
 */
export function registerGlobalShortcuts(
  resolveWindow: () => ShortcutTargetWindow | null,
): void {
  const registered = globalShortcut.register(SUMMON_ACCELERATOR, () => {
    const window = resolveWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    if (!window.isVisible()) {
      window.show();
    }
    window.focus();
  });
  if (!registered) {
    log.warn("[shortcuts] global shortcut registration refused", {
      accelerator: SUMMON_ACCELERATOR,
    });
    return;
  }
  log.info("[shortcuts] global shortcut registered", {
    accelerator: SUMMON_ACCELERATOR,
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
}
