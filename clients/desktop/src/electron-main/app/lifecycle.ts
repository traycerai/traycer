import { app, powerMonitor, session } from "electron";
import { join } from "node:path";
import { DESKTOP_APP_USER_MODEL_ID } from "../../config";
import { log } from "./logger";

/**
 * Persists V8 bytecode cache to disk so subsequent launches skip the JS
 * parse/compile step for hot modules. Measurable cold-start gain on a
 * multi-MB renderer bundle. Must be called after `app.whenReady()` since
 * `session.defaultSession` is not available before it.
 */
export function configureV8CodeCache(): void {
  const cacheDir = join(app.getPath("userData"), "v8-code-cache");
  session.defaultSession.setCodeCachePath(cacheDir);
  log.debug("[lifecycle] v8 code cache path", { cacheDir });
}

/**
 * Trim Chromium features the app never uses. Reduces RSS and CPU for
 * subsystems that would otherwise sit idle. Must be called before
 * `app.whenReady()` - command-line switches are read at Chromium init.
 *
 * `use-mock-keychain` is critical on macOS: without it, Chromium's OSCrypt
 * initializes cookie encryption against the real Keychain at app launch,
 * which creates a "Traycer Safe Storage" item and prompts the user for
 * their login password. The renderer's auth tokens go through
 * `encrypt-storage` (AES in localStorage), not cookies, so plaintext
 * cookies on disk are an acceptable trade for skipping the prompt.
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
  app.commandLine.appendSwitch("use-mock-keychain");
  // Cap Chromium's HTTP/code disk cache. Without a cap it grows to a
  // percentage of free disk; this app serves its bundle from a single
  // `app://` origin, so 256 MB is generous and bounds the footprint.
  app.commandLine.appendSwitch("disk-cache-size", String(256 * 1024 * 1024));
}

/**
 * Raises V8's old-space ceiling for the renderer + main heap. Traycer's
 * renderer holds long-lived agent transcripts, document snapshots, and
 * cached host state - the default ~2GB cap is close enough for some
 * users to hit OOM on large epics. 4GB is conservative; bump if telemetry
 * shows actual usage approaching this. Must run pre-ready.
 */
export function configureV8HeapSize(): void {
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
}

/**
 * Windows-only: required for toast-notification grouping and jumplist
 * support. Without an AppUserModelId, toasts may be attributed to
 * "electron.app.Traycer" instead of the product, and jumplist entries are
 * dropped. The id must match the AppUserModelId baked into the installer -
 * electron-builder uses `appId` from `build.appId` for this.
 */
export function configureAppUserModelId(): void {
  if (process.platform !== "win32") return;
  app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID);
}

/**
 * Subscribes to OS power events. Callers receive coarse-grained signals so
 * they can pause polling (host lifecycle watcher) or release expensive
 * resources on sleep, and resume on wake.
 */
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
