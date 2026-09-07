import { URL } from "node:url";
import { shell, session, type Session, type WebContents } from "electron";
import { log } from "./logger";
import { confirmDestructiveInMain } from "./confirm-destructive";
import { CONTENT_SECURITY_POLICY } from "../../shared/content-security-policy";
import { isDevBuild } from "../../config";
import { devRendererOriginFromEnv } from "../../ipc-contracts/dev-renderer-origin";

const ALLOWED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

export const SAFE_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "mailto:",
  "tel:",
  "sms:",
  "facetime:",
  "facetime-audio:",
]);

/**
 * Schemes that must NEVER be handed to `shell.openExternal` - the ones that turn an OS hand-off into a local-code or credential-exfiltration primitive.
 * `file:` is here (and also stays blocked as a guest navigation), so an http(s) page cannot reach it by any door.
 */
export const DANGEROUS_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "blob:",
  "file:",
  "filesystem:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "vbscript:",
  "ws:",
  "wss:",
]);

/**
 * The scheme is never allowed near `shell.openExternal`: it is in the dangerous denylist, or it is an `about:` other than `about:blank`.
 * Both launch primitives self-guard on this so a future or mistaken caller cannot turn the OS hand-off into a local-code door.
 */
function isRefusedGuestLaunchScheme(scheme: string): boolean {
  return DANGEROUS_EXTERNAL_SCHEMES.has(scheme) || scheme === "about:";
}

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
 * The OS presents its own confirmation, so a real external scheme is never a silent no-op.
 * The guest hand-off is instead denylist-gated by its caller (`handleExternalGuestScheme` in `browser-guest-navigation.ts`), so this helper only performs the launch and reports.
 */
export async function launchExternalFromGuest(url: string): Promise<boolean> {
  let scheme = "<unparseable>";
  try {
    scheme = new URL(url).protocol;
  } catch {
    log.warn("[security] guest external open rejected: unparseable");
    return false;
  }
  // Self-guard: never hand a dangerous scheme to the OS even if a caller's
  // classification let it through. The scheme (never the url) is logged.
  if (isRefusedGuestLaunchScheme(scheme)) {
    log.warn("[security] guest external open rejected: scheme", { scheme });
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    log.error("[security] guest external open failed", { scheme, err });
    return false;
  }
}

const confirmedGuestExternalSchemes = new Set<string>();

const pendingGuestExternalConfirms = new Map<string, Promise<boolean>>();

/**
 * Prompts the user with a native dialog the first time a given scheme is seen this app run.
 * Awaited only internally - callers fire-and-forget so a `setWindowOpenHandler` can still return synchronously.
 */
export async function confirmAndLaunchExternalScheme(
  url: string,
): Promise<boolean> {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    log.warn("[security] guest external confirm rejected: unparseable");
    return false;
  }
  // Self-guard: the confirm path must not become a door to a dangerous scheme
  // either, regardless of how it was reached.
  if (isRefusedGuestLaunchScheme(scheme)) {
    log.warn("[security] guest external confirm rejected: scheme", { scheme });
    return false;
  }
  if (confirmedGuestExternalSchemes.has(scheme)) {
    return launchExternalFromGuest(url);
  }
  // Join an in-flight confirm for the same scheme rather than stacking a second
  // identical dialog; each caller still launches its OWN url once approved.
  const inFlight = pendingGuestExternalConfirms.get(scheme);
  if (inFlight !== undefined) {
    const approved = await inFlight;
    return approved ? launchExternalFromGuest(url) : false;
  }
  const confirmPromise = confirmDestructiveInMain({
    title: "Open in another app?",
    message: `This page wants to open “${scheme.replace(
      /:$/,
      "",
    )}” in another app.`,
    detail: "Open it only if you trust this page.",
    confirmLabel: "Open",
  });
  pendingGuestExternalConfirms.set(scheme, confirmPromise);
  let approved: boolean;
  try {
    approved = await confirmPromise;
  } finally {
    pendingGuestExternalConfirms.delete(scheme);
  }
  if (!approved) {
    log.info("[security] guest external open declined", { scheme });
    return false;
  }
  confirmedGuestExternalSchemes.add(scheme);
  return launchExternalFromGuest(url);
}

/** Test-only reset for the per-app-run confirmed-scheme set, so a suite's "prompts once" and "prompts again" cases don't leak grants into each other. */
export function resetConfirmedGuestExternalSchemesForTest(): void {
  confirmedGuestExternalSchemes.clear();
  pendingGuestExternalConfirms.clear();
}

/**
 * External `<a href>` must open via `window.open`, never inside the renderer.
 * Same-document hash navigations are allowed; they do not change origin.
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
 * The renderer is a desktop SPA, not a browser.
 * Do not narrow this without re-reading `traycer-host`'s `BROWSER_CAPTURE_HELPER_PERMISSIONS`.
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

const CSP_HEADER_VALUE: readonly string[] = [CONTENT_SECURITY_POLICY];

export function installContentSecurityPolicy(target: Session): void {
  target.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    headers["Content-Security-Policy"] = CSP_HEADER_VALUE as string[];
    callback({ responseHeaders: headers });
  });
}

export function clampSessionTls(target: Session): void {
  target.setSSLConfig({
    minVersion: "tls1.2",
  });
}

export function hardenDefaultSession(): void {
  const defaultSession = session.defaultSession;
  installPermissionHandlers(defaultSession);
  installContentSecurityPolicy(defaultSession);
  clampSessionTls(defaultSession);
}
