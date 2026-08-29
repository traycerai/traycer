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

/**
 * The browser tile's video plane answers a peer connection from a headless
 * Chrome that is, for a local host, on this very machine (`127.0.0.1`).
 * Chromium's default policy hides local IPs behind `.local` mDNS names the
 * peer cannot resolve, which costs that pairing its only path - there is no
 * TURN, and the fallback is the slower JPEG plane. The host end sets the same
 * policy on its capture helper (`BROWSER_CAPTURE_IP_HANDLING_POLICY_FLAG`).
 *
 * Set per `webContents`, NOT as `--webrtc-ip-handling-policy`: that switch is
 * read by `chrome/browser`, which Electron does not ship - Electron surfaces
 * the preference through this method instead (electron/electron#8777), so the
 * raw switch would be a silent no-op and every tile would quietly stay on
 * JPEG. Registered on `web-contents-created` so it covers every window and
 * `WebContentsView` without a per-call-site opt-in.
 */
export function configureWebRtcIpPolicy(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy("default_public_and_private_interfaces");
  });
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
