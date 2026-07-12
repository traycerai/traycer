import {
  BrowserWindow,
  type Event,
  type WebContentsConsoleMessageEventParams,
} from "electron";
import { canOpenDevTools, isDevBuild } from "../../config";
import { createInitialRouteArg } from "../../ipc-contracts/window-bootstrap";
import {
  log,
  redactLogText,
  sanitizeLogFields,
  type SafeLogFields,
} from "../app/logger";
import {
  appendPerfEvent,
  type PerfFieldValue,
} from "../perf/perf-telemetry-writer";
import { parsePerfRendererLog } from "../perf/perf-renderer-log";
import { safelyOpenExternal, installNavigationGuard } from "../app/security";
import { installContextMenu } from "../app/spell-check";
import { installResponsivenessListeners } from "../app/responsiveness";
import { buildAppUrl } from "../app/app-protocol";
import { devRendererUrlFromEnv } from "../../ipc-contracts/dev-renderer-origin";
import { minimumWindowSize } from "./window-layout";
import {
  placementToBrowserWindowBounds,
  type WindowGeometryPlacement,
} from "./window-geometry";
import {
  readResolutionTestWindowConfig,
  shouldUseBuiltRendererForResolutionTest,
} from "./resolution-test-env";

const STRUCTURED_RENDERER_LOG_PREFIX = "[traycer-gui]";

export interface MainWindowOptions {
  readonly devWindowTitle: string | null;
  readonly preloadPath: string;
  readonly windowId: string;
  readonly initialRoute: string | null;
  readonly zoomFactor: number;
  readonly placement: WindowGeometryPlacement;
}

/**
 * Creates the single top-level `BrowserWindow`.
 *
 * Loading strategy is configuration-driven (derived from `config.isDevBuild`):
 *   - On the dev slot, load the Vite dev server at the loopback
 *     `TRAYCER_DESKTOP_DEV_URL` so HMR-enabled renderer assets are served.
 *   - Otherwise, load the renderer through the privileged `app://` scheme
 *     registered in `app-protocol.ts`. The protocol handler serves files
 *     from `<process.resourcesPath>/renderer` (packaged builds).
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const minSize = minimumWindowSize();
  const resolutionTest = readResolutionTestWindowConfig(process.env);
  const placementBounds =
    resolutionTest.bounds === null
      ? placementToBrowserWindowBounds(options.placement)
      : {
          width: resolutionTest.bounds.width,
          height: resolutionTest.bounds.height,
          x: undefined,
          y: undefined,
        };
  const window = new BrowserWindow({
    ...(options.devWindowTitle === null
      ? {}
      : { title: options.devWindowTitle }),
    width: placementBounds.width,
    height: placementBounds.height,
    x: placementBounds.x,
    y: placementBounds.y,
    minWidth: minSize.width,
    minHeight: minSize.height,
    show: false,
    // Background-paint color before the renderer paints - eliminates the
    // white flash on launch. Matches the renderer's dark surface color.
    backgroundColor: "#0b0b0d",
    // macOS: traffic lights overlay the renderer so the header acts as the
    // title bar (matches VS Code / Linear). Windows: native min/max/close
    // controls in an overlay so the renderer can claim the rest of the
    // title-bar surface as a drag region. Linux: default OS chrome.
    titleBarStyle: isMac ? "hiddenInset" : isWindows ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    // `titleBarOverlay: true` on mac activates Chromium's Window Controls
    // Overlay API so the renderer can read native control geometry via
    // `navigator.windowControlsOverlay` + the `env(titlebar-area-*)` CSS
    // env vars. Mac ignores the color/height options but the truthy value
    // is what flips WCO emission on.
    titleBarOverlay: isWindows
      ? { color: "#0b0b0d", symbolColor: "#e5e5e5", height: 36 }
      : isMac
        ? true
        : undefined,
    webPreferences: {
      preload: options.preloadPath,
      additionalArguments:
        options.initialRoute === null
          ? []
          : [createInitialRouteArg(options.initialRoute)],
      contextIsolation: true,
      nodeIntegration: false,
      // Staging installs use shipped renderer/runtime wiring but still need
      // an inspector for dogfood debugging. Production is the only slot where
      // Electron DevTools are disabled at the BrowserWindow level.
      devTools: canOpenDevTools,
      // Renderer + preload run inside Chromium's OS sandbox. Defense in
      // depth: a renderer compromise (V8 zero-day, contextIsolation bypass)
      // can no longer reach the filesystem, spawn processes, or open raw
      // sockets. Preload is already Node-free (only `electron` imports +
      // `process.argv`), so the flip is mechanical. All OS-touching work
      // already lives in main behind IPC.
      sandbox: true,
      zoomFactor: options.zoomFactor,
    },
  });

  void window.webContents.setVisualZoomLevelLimits(1, 1).catch((err) => {
    log.warn("[window] failed to lock visual zoom limits", err);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void safelyOpenExternal(url);
    return { action: "deny" };
  });

  installNavigationGuard(window.webContents);
  installContextMenu(window.webContents);
  installResponsivenessListeners(window.webContents);

  const devWindowTitle = options.devWindowTitle;
  if (devWindowTitle !== null) {
    // The renderer's document title is the generic product name. Keep the
    // native title bound to the runtime app identity so concurrent dev stacks
    // stay distinguishable in the window switcher and Dock.
    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(devWindowTitle);
    });
  }

  window.once("ready-to-show", () => {
    // Open filling the screen's work area (full width/height minus OS
    // taskbar/menu). `maximize()` keeps native window chrome + the snap/restore
    // affordance, unlike fullscreen which hides the menu bar.
    if (options.placement.maximized && !resolutionTest.disableMaximize) {
      window.maximize();
    }
    window.show();
  });

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      log.error("[window] did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    log.error("[window] preload-error", {
      preloadPath,
      error,
    });
  });

  // Pipe the renderer (web) console into the desktop log. The renderer console
  // is otherwise captured nowhere - the visibility gap that left earlier
  // sleep/wake investigations guessing about what the renderer actually did on
  // resume. Keeps the wake-recovery trace (wake trigger -> reconnect ->
  // revalidate -> online) observable in one log file on a real device.
  //
  // Forward renderer console output into the app log so renderer-side failures
  // (e.g. a sign-in that fails after the OAuth callback) are diagnosable from
  // the shipped log file - production gates DevTools off, so without this the
  // renderer's own errors are captured nowhere.
  //
  // dev/staging (DevTools-enabled dogfood builds) mirror EVERY level - the full
  // firehose is wanted there. Production stays lean: only `warning`/`error` are
  // forwarded (at the matching log level) so a chatty renderer can't inflate the
  // shipped log, while real failures are still recorded.
  window.webContents.on(
    "console-message",
    (details: Event<WebContentsConsoleMessageEventParams>) => {
      // Perf-telemetry lines go ONLY to the dedicated NDJSON file, never the
      // human log. Handle them first and return so they bypass electron-log.
      const perfEvent = parsePerfRendererLog(details.message);
      if (perfEvent !== null) {
        appendPerfEvent({
          ...perfEvent,
          fields: redactPerfFields(perfEvent.fields),
        });
        return;
      }
      const structured = parseStructuredRendererLog(details.message);
      const entry = {
        message:
          structured === null
            ? redactLogText(details.message)
            : structured.message,
        line: details.lineNumber,
        source: sanitizeRendererSource(details.sourceId),
        ...(structured === null ? {} : { fields: structured.fields }),
      };
      if (structured !== null) {
        logStructuredRendererEntry(structured.level, entry);
        return;
      }
      if (canOpenDevTools) {
        log.info("[renderer]", { level: details.level, ...entry });
        return;
      }
      if (details.level === "error") {
        log.error("[renderer]", entry);
      } else if (details.level === "warning") {
        log.warn("[renderer]", entry);
      }
    },
  );

  return window;
}

export async function loadMainWindow(
  window: MainWindowLoadTarget,
): Promise<void> {
  // The dev slot (the `make dev-desktop` orchestrator) loads the Vite dev
  // server with HMR. DevTools are NOT auto-opened - use the View menu's
  // "Toggle Developer Tools" when policy exposes it. Shipped builds fall
  // through to the privileged `app://` scheme below.
  if (isDevBuild && !shouldUseBuiltRendererForResolutionTest(process.env)) {
    const devRendererUrl = devRendererUrlFromEnv(process.env);
    log.info("[window] loading dev renderer", { devUrl: devRendererUrl });
    try {
      await window.loadURL(devRendererUrl);
      return;
    } catch (err) {
      log.error("[window] dev renderer load failed", err);
    }
  }

  // Default load path: the privileged `app://` scheme registered in
  // `app/app-protocol.ts`. `app://` is `standard: true, secure: true` so
  // the renderer gets a real web origin, enabling service workers and
  // tightening the CSP `default-src 'self'` posture.
  const rendererUrl = buildAppUrl();
  log.info("[window] loading renderer from", { rendererUrl });
  await window.loadURL(rendererUrl);
}

export interface MainWindowLoadTarget {
  loadURL(url: string): Promise<void>;
}

type StructuredRendererLogLevel = "debug" | "info" | "warn" | "error";

interface StructuredRendererLog {
  readonly level: StructuredRendererLogLevel;
  readonly message: string;
  readonly fields: SafeLogFields;
}

function parseStructuredRendererLog(
  message: string,
): StructuredRendererLog | null {
  if (!message.startsWith(STRUCTURED_RENDERER_LOG_PREFIX)) {
    return null;
  }
  const rawJson = message.slice(STRUCTURED_RENDERER_LOG_PREFIX.length).trim();
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!isRecord(parsed)) return null;
    const level = parsed.level;
    const logMessage = parsed.message;
    if (!isRendererLogLevel(level) || typeof logMessage !== "string") {
      return null;
    }
    return {
      level,
      message: redactLogText(logMessage),
      fields: isRecord(parsed.fields)
        ? sanitizeRendererFields(parsed.fields)
        : {},
    };
  } catch {
    return null;
  }
}

function sanitizeRendererFields(
  fields: Record<string, unknown>,
): SafeLogFields {
  return sanitizeLogFields(fields);
}

/**
 * Perf fields are `number | string | boolean | null` only (never a nested
 * object/array), so this stays narrower than `sanitizeLogFields`: only string
 * values need scrubbing through the same `redactLogText` used on every other
 * renderer log path, so a future call site that passes a user-derived string
 * (error message, file path) as a field can't land unredacted in the perf
 * NDJSON sink.
 */
function redactPerfFields(
  fields: Readonly<Record<string, PerfFieldValue>>,
): Record<string, PerfFieldValue> {
  const out: Record<string, PerfFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? redactLogText(value) : value;
  }
  return out;
}

function logStructuredRendererEntry(
  level: StructuredRendererLogLevel,
  entry: SafeLogFields,
): void {
  if (level === "error") {
    log.error("[renderer]", entry);
    return;
  }
  if (level === "warn") {
    log.warn("[renderer]", entry);
    return;
  }
  if (level === "info") {
    log.info("[renderer]", entry);
    return;
  }
  log.debug("[renderer]", entry);
}

function sanitizeRendererSource(sourceId: string): string {
  try {
    const url = new URL(sourceId);
    url.search = "";
    url.hash = "";
    return redactLogText(url.toString());
  } catch {
    return redactLogText(sourceId);
  }
}

function isRendererLogLevel(
  value: unknown,
): value is StructuredRendererLogLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
