import { app, powerMonitor, session } from "electron";
import { join } from "node:path";
import { DESKTOP_APP_USER_MODEL_ID } from "../../config";
import { log } from "./logger";

/** Must be called after `app.whenReady()` since `session.defaultSession` is not available before it. */
export function configureV8CodeCache(): void {
  const cacheDir = join(app.getPath("userData"), "v8-code-cache");
  session.defaultSession.setCodeCachePath(cacheDir);
  log.debug("[lifecycle] v8 code cache path", { cacheDir });
}

/**
 * Trim Chromium features the app never uses.
 * Must be called before `app.whenReady()` - command-line switches are read at Chromium init.
 */
export function trimUnusedChromiumFeatures(): void {
  app.commandLine.appendSwitch(
    "disable-features",
    [
      "Translate",
      "MediaRouter",
      "OptimizationHints",
      "OptimizationGuideModelDownloading",
      "InterestFeedContentSuggestions",
      "AutofillServerCommunication",
    ].join(","),
  );
  // Cap Chromium's HTTP/code disk cache. Without a cap it grows to a
  // percentage of free disk; this app serves its bundle from a single
  // `app://` origin, so 256 MB is generous and bounds the footprint.
  app.commandLine.appendSwitch("disk-cache-size", String(256 * 1024 * 1024));
}

/** Must run pre-ready. */
export function configureV8HeapSize(): void {
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
}

/** The id must match the AppUserModelId baked into the installer - electron-builder uses `appId` from `build.appId` for this. */
export function configureAppUserModelId(): void {
  if (process.platform !== "win32") return;
  app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID);
}

export interface PowerEventHandlers {
  readonly onSuspend: (() => void) | undefined;
  readonly onResume: (() => void) | undefined;
  readonly onLockScreen: (() => void) | undefined;
  readonly onUnlockScreen: (() => void) | undefined;
}

export function installPowerMonitorListeners(
  handlers: Partial<PowerEventHandlers>,
): void {
  powerMonitor.on("suspend", () => {
    log.info("[lifecycle] system suspending");
    handlers.onSuspend?.();
  });
  powerMonitor.on("resume", () => {
    log.info("[lifecycle] system resumed");
    handlers.onResume?.();
  });
  powerMonitor.on("lock-screen", () => {
    log.info("[lifecycle] screen locked");
    handlers.onLockScreen?.();
  });
  powerMonitor.on("unlock-screen", () => {
    log.info("[lifecycle] screen unlocked");
    handlers.onUnlockScreen?.();
  });
}
