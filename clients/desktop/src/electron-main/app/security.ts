import { URL } from "node:url";
import { shell, session, type Session, type WebContents } from "electron";
import { log } from "./logger";
import { CONTENT_SECURITY_POLICY } from "../../shared/content-security-policy";
import { isDevBuild } from "../../config";
import { devRendererOriginFromEnv } from "../../ipc-contracts/dev-renderer-origin";

const ALLOWED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

const ALLOWED_NAVIGATION_ORIGINS: ReadonlySet<string> = new Set([
  // Dev renderer Vite host. Production renderer is served from `file://` so
  // its origin is `null` and never matches - same-document navigations
  // there are detected via `isInPlace` in the navigation handler.
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function isAllowedNavigationOrigin(origin: string): boolean {
  if (ALLOWED_NAVIGATION_ORIGINS.has(origin)) return true;
  // `TRAYCER_DESKTOP_DEV_URL` is only meaningful (and only ever set) on a dev
  // build. Gating on `isDevBuild` means a stray/attacker-set env var in a
  // packaged production app can never widen the navigation allow-list.
  if (!isDevBuild) return false;
  try {
    return origin === devRendererOriginFromEnv(process.env);
  } catch {
    return false;
  }
}

/**
 * Centralized gate for `shell.openExternal`. Rejects opaque/non-web schemes
 * (`javascript:`, `data:`, `file:`, `vbscript:`, `chrome:`...) which can
 * exfiltrate credentials or invoke local apps. Renderer call sites should
 * route through this rather than calling `shell.openExternal` directly.
 */
export async function safelyOpenExternal(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.warn("[security] openExternal rejected: unparseable", { url });
    return false;
  }
  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    log.warn("[security] openExternal rejected: scheme", {
      url,
      scheme: parsed.protocol,
    });
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    log.error("[security] openExternal failed", { url, err });
    return false;
  }
}

/**
 * Blocks the renderer from navigating to off-origin URLs. The renderer is a
 * SPA - any `<a href>` to an external site should open in the user's browser
 * via `window.open` (already routed through `setWindowOpenHandler`), never
 * inside the Electron window. Same-document hash navigations are allowed
 * because they don't change origin and don't trigger a network fetch.
 */
export function installNavigationGuard(webContents: WebContents): void {
  webContents.on("will-navigate", (event, navigationUrl) => {
    let target: URL;
    try {
      target = new URL(navigationUrl);
    } catch {
      event.preventDefault();
      return;
    }
    const currentUrl = webContents.getURL();
    let currentOrigin = "";
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      currentOrigin = "";
    }
    if (target.origin === currentOrigin) {
      return;
    }
    if (isAllowedNavigationOrigin(target.origin)) {
      return;
    }
    log.warn("[security] navigation blocked", {
      from: currentUrl,
      to: navigationUrl,
    });
    event.preventDefault();
    void safelyOpenExternal(navigationUrl);
  });
}

/**
 * Default-deny permission handlers for geolocation/notifications/etc. The
 * renderer is a desktop SPA, not a browser - it should never need geolocation,
 * midi, etc. Notifications are surfaced through our IPC-driven native path, so
 * the web Notification permission is also denied to avoid permission-prompt UI.
 *
 * `media` is the one exception: voice dictation needs `getUserMedia({audio})`,
 * so we allow it for **audio only** (camera/video stays denied). The macOS TCC
 * prompt is gated by `NSMicrophoneUsageDescription` + the audio-input
 * entitlement; this handler is the Chromium-layer gate.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

export function installPermissionHandlers(target: Session): void {
  target.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === "media") {
        const mediaTypes =
          "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
        const audioOnly =
          mediaTypes.includes("audio") && !mediaTypes.includes("video");
        if (!audioOnly) {
          log.warn("[security] media permission denied (audio-only allowed)", {
            mediaTypes,
          });
        }
        callback(audioOnly);
        return;
      }
      const allowed = ALLOWED_PERMISSIONS.has(permission);
      if (!allowed) {
        log.warn("[security] permission denied", { permission });
      }
      callback(allowed);
    },
  );
  target.setPermissionCheckHandler(
    (_webContents, permission, _origin, details) => {
      if (permission === "media") {
        // Mic-only (dictation). Fail closed: allow ONLY audio, denying camera
        // and the optional/unknown `mediaType` (Electron types it optional, so a
        // `!== "video"` check would grant on `undefined`).
        return details.mediaType === "audio";
      }
      return ALLOWED_PERMISSIONS.has(permission);
    },
  );
  // Hardware-device prompts: deny everything categorically since the app
  // never uses WebUSB, WebBluetooth, getDisplayMedia, or HID.
  target.setDevicePermissionHandler(() => false);
  target.setUSBProtectedClassesHandler(() => []);
  target.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false });
  });
  target.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
}

/**
 * Header layer of the renderer Content-Security-Policy. The directive list
 * lives in `shared/content-security-policy.ts` so this header and the
 * index.html `<meta>` tag (injected by `vite.renderer.config.ts`) are sourced
 * from one constant and cannot drift.
 */
const CSP_HEADER_VALUE: readonly string[] = [CONTENT_SECURITY_POLICY];

export function installContentSecurityPolicy(target: Session): void {
  target.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    headers["Content-Security-Policy"] = CSP_HEADER_VALUE as string[];
    callback({ responseHeaders: headers });
  });
}

/**
 * Clamps the default session to TLS 1.2+ so renderer/main HTTP traffic
 * can't be downgraded to TLS 1.0/1.1 by a hostile network. The host
 * runs over loopback so this only affects outbound calls.
 */
export function clampSessionTls(target: Session): void {
  target.setSSLConfig({
    minVersion: "tls1.2",
  });
}

/**
 * Convenience wrapper for the default session - applies the full security
 * suite at app-ready time.
 */
export function hardenDefaultSession(): void {
  const defaultSession = session.defaultSession;
  installPermissionHandlers(defaultSession);
  installContentSecurityPolicy(defaultSession);
  clampSessionTls(defaultSession);
}
