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
import { safelyOpenExternal, installNavigationGuard } from "../app/security";
import { installContextMenu } from "../app/spell-check";
import { installResponsivenessListeners } from "../app/responsiveness";
import { buildAppUrl } from "../app/app-protocol";

// Vite dev server served by the `make dev-desktop` orchestrator.
const DEV_RENDERER_URL = "http://localhost:5173";
const STRUCTURED_RENDERER_LOG_PREFIX = "[traycer-gui]";

export interface MainWindowOptions {
  readonly preloadPath: string;
  readonly windowId: string;
  readonly initialRoute: string | null;
}

/**
 * Creates the single top-level `BrowserWindow`.
 *
 * Loading strategy is configuration-driven (derived from `config.isDevBuild`):
 *   - On the dev slot, load the Vite dev server at `DEV_RENDERER_URL`
 *     (`http://localhost:5173`) so HMR-enabled renderer assets are served.
 *   - Otherwise, load the renderer through the privileged `app://` scheme
 *     registered in `app-protocol.ts`. The protocol handler serves files
 *     from `<process.resourcesPath>/renderer` (packaged builds).
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
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
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void safelyOpenExternal(url);
    return { action: "deny" };
  });

  installNavigationGuard(window.webContents);
  installContextMenu(window.webContents);
  installResponsivenessListeners(window.webContents);

  window.once("ready-to-show", () => {
    // Open filling the screen's work area (full width/height minus OS
    // taskbar/menu). `maximize()` keeps native window chrome + the snap/restore
    // affordance, unlike fullscreen which hides the menu bar.
    window.maximize();
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
  if (isDevBuild) {
    log.info("[window] loading dev renderer", { devUrl: DEV_RENDERER_URL });
    try {
      await window.loadURL(DEV_RENDERER_URL);
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
