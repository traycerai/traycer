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

/**
 * Schemes safe to hand STRAIGHT to the OS with no extra confirmation - the OS
 * handler (mail client, dialer) is itself the gate and these carry no local-app
 * launch risk. The one source of truth for the guest hand-off policy, consumed
 * by `browser-guest-navigation.ts`; it lives here so the launch primitives
 * below can self-guard against the dangerous set rather than trusting a caller.
 */
export const SAFE_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "mailto:",
  "tel:",
  "sms:",
  "facetime:",
  "facetime-audio:",
]);

/**
 * Schemes that must NEVER be handed to `shell.openExternal` - the ones that
 * turn an OS hand-off into a local-code or credential-exfiltration primitive.
 * `file:` is here (and also stays blocked as a guest navigation), so an http(s)
 * page cannot reach it by any door. `about:` is dangerous for every value but
 * `about:blank`, which callers handle before this set is consulted.
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
 * The scheme is never allowed near `shell.openExternal`: it is in the dangerous
 * denylist, or it is an `about:` other than `about:blank`. Both launch
 * primitives self-guard on this so a future or mistaken caller cannot turn the
 * OS hand-off into a local-code door - defense in depth behind the caller's own
 * allow/deny classification.
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
 * Fire-and-forget hand-off of a browser GUEST's non-web navigation to the OS
 * default handler (Chrome's "open in <app>?" behaviour for `mailto:`, `tel:`,
 * `zoommtg://`, `slack://`, ...). The OS presents its own confirmation, so a
 * real external scheme is never a silent no-op.
 *
 * Deliberately DISTINCT from {@link safelyOpenExternal}, which gates the
 * renderer's user-initiated in-app link egress against the fixed
 * {@link ALLOWED_EXTERNAL_SCHEMES} allow-list. The guest hand-off is instead
 * denylist-gated by its caller (`handleExternalGuestScheme` in
 * `browser-guest-navigation.ts`), so this helper only performs the launch and
 * reports failure - it must NOT be reached for a renderer link, and the two
 * policies stay separate on purpose. The scheme (never the URL) is logged: a
 * guest URL can carry attacker-chosen bytes.
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

/**
 * Schemes a guest hand-off has confirmed this app run. An arbitrary app deep
 * link (`zoommtg:`, `slack:`, ...) prompts once; a later hand-off to the SAME
 * scheme opens without re-prompting - "one-time per app". Cleared only by
 * restarting the app.
 *
 * ponytail: process-wide, not per browser session. Thread a session key
 * through {@link confirmAndLaunchExternalScheme} if we ever want the grant to
 * reset per session.
 */
const confirmedGuestExternalSchemes = new Set<string>();

/**
 * Confirm dialogs in flight, keyed by scheme. A page firing two `zoommtg:`
 * navigations in the same tick would otherwise open two identical dialogs (the
 * "remembered" set is only written after approval); a concurrent second call
 * for the same scheme joins the first dialog's result instead.
 */
const pendingGuestExternalConfirms = new Map<string, Promise<boolean>>();

/**
 * The "middle path" hand-off for an ARBITRARY app scheme a guest tries to open
 * (not the always-safe `mailto:`/`tel:` set, not the dangerous denylist - those
 * are decided by the caller). Prompts the user with a native dialog the first
 * time a given scheme is seen this app run; on "Open" it launches AND remembers
 * the scheme so it never re-prompts, on "Cancel" it does nothing. Awaited only
 * internally - callers fire-and-forget so a `setWindowOpenHandler` can still
 * return synchronously.
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

/**
 * Test-only reset for the per-app-run confirmed-scheme set, so a suite's
 * "prompts once" and "prompts again" cases don't leak grants into each other.
 */
export function resetConfirmedGuestExternalSchemesForTest(): void {
  confirmedGuestExternalSchemes.clear();
  pendingGuestExternalConfirms.clear();
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
 *
 * That audio allowance is load-bearing beyond dictation: Chromium's WebRTC port
 * allocator consults this same permission CHECK, and a denial makes it gather
 * from one wildcard-bound socket with mDNS-obfuscated candidates instead of
 * real per-interface ones - which removes the VPN/tailnet host candidate the
 * remote browser video plane's direct path depends on. Do not narrow this
 * without re-reading `traycer-host`'s `BROWSER_CAPTURE_HELPER_PERMISSIONS`.
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
