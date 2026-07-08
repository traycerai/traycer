import { app } from "electron";
import { DESKTOP_PROTOCOL_SCHEME } from "../../config";
import { log } from "../app/logger";

// Environment-specific so a dev build doesn't share `traycer://` with an
// installed staging/prod app (see `DESKTOP_PROTOCOL_SCHEME`).
const PROTOCOL_SCHEME = DESKTOP_PROTOCOL_SCHEME;
const AUTH_CALLBACK_PATH = "auth/callback";

/**
 * Fired when the user returns from the device-approval browser tab via a
 * `traycer://auth/callback` deep link. It is a pure, payload-free signal: the
 * handler focuses the window and nudges the in-flight device poll (see
 * `runner-ipc-bridge.deliverAuthReturnSignal`). It parses no query string and
 * drives no token exchange - device flow is the only login, and the token
 * always arrives over the `/device/token` poll, so the deep link is just an
 * optimization. Login still completes poll-only if it never fires.
 */
export type AuthReturnSignalHandler = () => void;

/**
 * Whether `uri` is a `traycer://auth/callback` deep link (ignoring any query).
 * A stray legacy `?code=…` is tolerated - we never read it. Other traycer
 * deep links (e.g. session links) and non-traycer URIs return `false`.
 */
function isAuthCallbackUri(uri: string): boolean {
  if (!uri.startsWith(`${PROTOCOL_SCHEME}://`)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const path = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return path === AUTH_CALLBACK_PATH;
}

/**
 * Registers the `traycer://` custom protocol and wires the platform-specific
 * entry points:
 *   - `app.setAsDefaultProtocolClient` is the cross-platform registration
 *     call. On macOS this is enough because OS deep links arrive via
 *     `open-url`. On Windows/Linux, Electron delivers the URL as an extra
 *     `argv` string to the secondary instance, so we also need
 *     `second-instance` with `app.requestSingleInstanceLock()`.
 *   - Early CLI argv scan catches links delivered on cold start before any
 *     window exists.
 *
 * The protocol registration is unchanged from the redirect era; only the
 * handler is demoted. A `traycer://auth/callback` deep link fires the
 * payload-free `AuthReturnSignalHandler` (focus + poll-nudge); it parses no
 * payload and drives no exchange. Non-auth traycer URIs are ignored.
 */
export function registerDeepLinkHandling(
  handler: AuthReturnSignalHandler,
): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        process.argv[1],
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }

  const deliver = (uri: string): void => {
    if (!isAuthCallbackUri(uri)) {
      return;
    }
    log.info("[deep-link] auth return signal - nudging the device poll");
    handler();
  };

  app.on("open-url", (event, url) => {
    event.preventDefault();
    log.info("[deep-link] open-url", { url: redactDeepLinkUrl(url) });
    deliver(url);
  });

  app.on("second-instance", (_event, argv) => {
    const url = findTraycerUrlInArgv(argv);
    if (url !== null) {
      log.info("[deep-link] second-instance", { url: redactDeepLinkUrl(url) });
      deliver(url);
    }
  });

  const initial = findTraycerUrlInArgv(process.argv);
  if (initial !== null) {
    log.info("[deep-link] initial argv contained deep link", {
      url: redactDeepLinkUrl(initial),
    });
    app.whenReady().then(() => deliver(initial));
  }
}

/**
 * Strips the query string (and anything after it) from a deep-link URL before
 * logging. A legacy redirect callback could still carry a stray `?code=…`, so
 * keep only the scheme/host/path for diagnostics rather than logging it.
 */
function redactDeepLinkUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<malformed>";
  }
}

function isTraycerUrl(value: string): boolean {
  return value.startsWith(`${PROTOCOL_SCHEME}://`);
}

function findTraycerUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (isTraycerUrl(arg)) {
      return arg;
    }
  }
  return null;
}

export { PROTOCOL_SCHEME };
