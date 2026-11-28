import { app } from "electron";
import { config, DESKTOP_PROTOCOL_SCHEME } from "../../config";
import { log } from "../app/logger";
import {
  devDesktopSlotForEnvironment,
  devDesktopSlotProtocolScheme,
} from "../host/dev-desktop-slot";

// Environment-specific so a dev build doesn't share `traycer://` with an
// installed staging/prod app (see `DESKTOP_PROTOCOL_SCHEME`), and
// slot-specific under multi-run dev so concurrent `make dev-desktop` runs
// don't steal each other's auth-callback deep links (the OS routes a scheme
// to exactly one app - last registration wins). Module-scope is safe:
// `DEV_DESKTOP_SLOT` is fixed for the lifetime of a real process (same
// contract as `cli-discovery.ts`). The renderer derives the matching
// redirect URI in `renderer-shell/sign-in-url.ts`; the two MUST agree or the
// cloud's redirect lands on a scheme nobody registered.
const PROTOCOL_SCHEME = devDesktopSlotProtocolScheme(
  DESKTOP_PROTOCOL_SCHEME,
  devDesktopSlotForEnvironment(config.environment, process.env),
);
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
 * Target of a `traycer://open/epic/<epicId>/chat/<chatId>` deep link. Ids only:
 * the link names WHERE to look, never WHAT to do there. No prompt text, no
 * action, no host override - so the worst a hostile link can do is bring one
 * of the signed-in user's own chats forward.
 */
export interface OpenChatDeepLinkTarget {
  readonly epicId: string;
  readonly chatId: string;
}

export type OpenChatDeepLinkHandler = (target: OpenChatDeepLinkTarget) => void;

const OPEN_CHAT_PATH = /^open\/epic\/([^/]+)\/chat\/([^/]+)$/;
// Epic and chat ids are UUIDs today; accept the same conservative alphabet
// the rest of the client treats as an opaque id, and nothing else (no dots,
// slashes, percent-escapes or whitespace survive to the renderer).
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
 * Parses `traycer://open/epic/<epicId>/chat/<chatId>[?focus=composer]`.
 * Returns `null` for anything else, including a malformed or over-long id.
 * The optional `focus` query is accepted and ignored: an activated chat tile
 * already autofocuses its composer on desktop (`ComposerPromptEditor`), so the
 * hint exists only so callers can state intent without breaking older builds.
 */
export function parseOpenChatUri(uri: string): OpenChatDeepLinkTarget | null {
  if (!uri.startsWith(`${PROTOCOL_SCHEME}://`)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  const path = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const match = OPEN_CHAT_PATH.exec(path);
  if (match === null) {
    return null;
  }
  const [, epicId, chatId] = match;
  if (!OPAQUE_ID.test(epicId) || !OPAQUE_ID.test(chatId)) {
    return null;
  }
  return { epicId, chatId };
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
 * payload and drives no exchange. A `traycer://open/epic/<id>/chat/<id>` link
 * fires `openChatHandler` with the validated ids. Every other traycer URI is
 * ignored.
 */
export function registerDeepLinkHandling(
  handler: AuthReturnSignalHandler,
  openChatHandler: OpenChatDeepLinkHandler,
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
    if (isAuthCallbackUri(uri)) {
      log.info("[deep-link] auth return signal - nudging the device poll");
      handler();
      return;
    }
    const target = parseOpenChatUri(uri);
    if (target === null) {
      return;
    }
    log.info("[deep-link] open chat");
    openChatHandler(target);
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
