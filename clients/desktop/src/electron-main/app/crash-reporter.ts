import { app, BrowserWindow, crashReporter } from "electron";
import * as SentryElectron from "@sentry/electron/main";
import { config } from "../../config";
import { log } from "./logger";
import { isSentryEnabled, markSentryEnabled } from "./crash-reporter-state";

export { isSentryEnabled } from "./crash-reporter-state";

/**
 * Wires native crash collection. `crashReporter.start()` must be called before
 * `app.whenReady()` resolves so that early renderer/main crashes are captured.
 * `@sentry/electron/main` extends crashReporter with Sentry's collector and
 * unhandled JS errors. The Sentry DSN + environment come from the
 * source-controlled `config` (the deploy script bakes the prod/staging DSN).
 */
export function initCrashReporter(): void {
  const dsn = config.sentryDsn;
  // Sentry environment label = the build's environment (dev / staging /
  // production).
  const environment = config.environment;
  const hasDsn = typeof dsn === "string" && dsn.length > 0;

  crashReporter.start({
    productName: "Traycer",
    companyName: "Traycer AI",
    submitURL: "",
    uploadToServer: false,
    compress: true,
  });

  // Init Sentry only when a DSN is set. Sentry's `async_hooks`-based
  // integrations have historically conflicted with DevTools attaching to
  // the main process (EXC_BREAKPOINT in `async_hooks_callback_trampoline`
  // when devtools breakpoints intersect Sentry's hook chain) - skipping
  // init when no DSN is set keeps dev devtools usable.
  if (!hasDsn) {
    log.info("[crash-reporter] sentry disabled (no DSN)", { environment });
    return;
  }
  const isProd = environment === "production";
  const sampleRate = isProd ? 0.1 : 1.0;
  SentryElectron.init({
    dsn,
    environment,
    release: app.getVersion(),
    tracesSampleRate: sampleRate,
    profilesSampleRate: sampleRate,
    attachStacktrace: true,
  });
  markSentryEnabled();
  log.info("[crash-reporter] sentry initialized", { environment });
}

/**
 * Listens for renderer + child process crashes and logs structured details.
 * `@sentry/electron` already reports these to Sentry when DSN is set; the
 * local log line ensures we have actionable diagnostics in `electron-log`
 * regardless of Sentry availability.
 */
export function installProcessGoneListeners(): void {
  // Only `will-quit` (fires when the app is actually quitting) flips this.
  // `before-quit` can be preventDefault'd while desktop-startup awaits a quit
  // decision, so a canceled quit would leave the flag stuck true and disable
  // crash recovery for the rest of the session.
  app.once("will-quit", () => {
    appIsQuitting = true;
  });
  app.on("render-process-gone", (_event, webContents, details) => {
    log.error("[crash-reporter] render-process-gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL(),
    });
    recoverCrashedRenderer(webContents, details.reason);
  });
  app.on("child-process-gone", (_event, details) => {
    log.error("[crash-reporter] child-process-gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    });
  });
}

const RENDERER_RELOAD_WINDOW_MS = 60_000;
const RENDERER_MAX_RELOADS_PER_WINDOW = 2;
const rendererReloadHistoryByWebContents = new Map<number, number[]>();
let appIsQuitting = false;

/**
 * Self-heals a crashed renderer. Without this, a renderer OOM/crash leaves the
 * user on a dead window. The renderer is local-first (it rehydrates from the
 * host + SQLite), so a reload is a safe, idempotent recovery. A crash-loop
 * cap stops us from reloading endlessly when the renderer crashes on boot.
 */
function recoverCrashedRenderer(
  webContents: Electron.WebContents,
  reason: Electron.RenderProcessGoneDetails["reason"],
): void {
  if (reason === "clean-exit") return;
  // Never resurrect a renderer during app shutdown: a normal `app.quit()`
  // tears renderers down with reasons like "killed"/"abnormal-exit", and a
  // reload here would spawn a fresh renderer mid-quit.
  if (appIsQuitting) return;
  const window = BrowserWindow.fromWebContents(webContents);
  if (window === null || window.isDestroyed()) return;

  const now = Date.now();
  const existing = rendererReloadHistoryByWebContents.get(webContents.id);
  const recent = (existing ?? []).filter(
    (at) => now - at < RENDERER_RELOAD_WINDOW_MS,
  );
  if (recent.length >= RENDERER_MAX_RELOADS_PER_WINDOW) {
    log.error("[crash-reporter] renderer crash-loop, leaving window dead", {
      webContentsId: webContents.id,
      reason,
      reloadsInWindow: recent.length,
    });
    return;
  }
  recent.push(now);
  if (existing === undefined) {
    // Free the history entry when the renderer goes away so the Map can't
    // grow unbounded across renderer churn.
    webContents.once("destroyed", () => {
      rendererReloadHistoryByWebContents.delete(webContents.id);
    });
  }
  rendererReloadHistoryByWebContents.set(webContents.id, recent);
  log.warn("[crash-reporter] reloading crashed renderer", {
    webContentsId: webContents.id,
    reason,
    attempt: recent.length,
  });
  window.reload();
}

/**
 * Installs the main-process error net. Without these, an uncaught exception
 * or unhandled promise rejection in the main process - e.g. a menu-command
 * handler whose fire-and-forget promise rejects - escapes to Node's default
 * handler, which under `--unhandled-rejections=throw` fatally aborts the
 * process with `SIGTRAP` / `EXC_BREAKPOINT` and no application-level log
 * (the renderer/child `*-process-gone` listeners do NOT cover the main
 * process itself). We log structured diagnostics and forward to Sentry when
 * enabled, and deliberately do not re-throw or exit: a single handler bug
 * should degrade to a logged event, not tear down the shell. Install this
 * pre-`whenReady`, right after `initCrashReporter()`, so the net is live
 * before any window or menu can dispatch.
 */
export function installGlobalErrorHandlers(): void {
  process.on("uncaughtException", (err, origin) => {
    log.error("[crash-reporter] uncaughtException", { origin, err });
    if (isSentryEnabled()) {
      SentryElectron.captureException(err, { tags: { origin } });
    }
  });
  process.on("unhandledRejection", (reason) => {
    log.error("[crash-reporter] unhandledRejection", { reason });
    if (isSentryEnabled()) {
      SentryElectron.captureException(reason);
    }
  });
}

/**
 * Captures GPU info into the startup log. Useful when triaging GPU-driver
 * crashes - attach this to bug reports alongside the crash dump.
 */
export async function logGpuInfo(): Promise<void> {
  try {
    const info = await app.getGPUInfo("basic");
    log.info("[crash-reporter] gpu info", { info });
  } catch (err) {
    log.warn("[crash-reporter] gpu info unavailable", { err });
  }
}
