import { app } from "electron";
import { DESKTOP_PROTOCOL_SCHEME } from "../../config";
import { log } from "../app/logger";

// Environment-specific so a dev build doesn't share `traycer://` with an
// installed staging/prod app (see `DESKTOP_PROTOCOL_SCHEME`).
const PROTOCOL_SCHEME = DESKTOP_PROTOCOL_SCHEME;
const AUTH_CALLBACK_PATH = "auth/callback";

/**
 * Result of parsing a `traycer://auth/callback` deep link. Mirrors the shared
 * `AuthCallbackResult` union from `@traycer-clients/shared/platform/runner-host`
 * - duplicated here so the Electron main process does not depend on the
 * shared module at runtime (main runs as CommonJS outside the shared module
 * resolution graph).
 */
export type AuthCallbackParseResult =
  | { readonly code: string }
  | { readonly error: string };

export type AuthCallbackHandler = (result: AuthCallbackParseResult) => void;

/**
 * Maps the query string of an auth-callback URL to an `AuthCallbackParseResult`.
 * Shared by the custom-scheme deep link (`parseAuthCallback`) and the loopback
 * HTTP server (`loopback-callback-server.ts`) so both surfaces apply identical
 * code / error semantics.
 *
 * Success requires a non-empty PKCE `code` parameter (tokens no longer travel
 * in the callback URL). An explicit `error` parameter, or the absence of a
 * usable code, collapses to the `{ error }` branch so callers never handle a
 * third "indeterminate" case.
 */
export function parseAuthCallbackParams(
  params: URLSearchParams,
): AuthCallbackParseResult {
  const explicitError = params.get("error");
  if (explicitError !== null && explicitError.length > 0) {
    return { error: explicitError };
  }

  const code = params.get("code");
  if (code === null || code.length === 0) {
    return { error: "missing code in auth callback" };
  }

  return { code };
}

/**
 * Parses a deep-link URI into an `AuthCallbackParseResult`. Returns `null`
 * when the URI is not a `traycer://auth/callback` deep link at all (so
 * non-auth traycer deep links can be ignored without being mis-reported as
 * an auth failure).
 *
 * Success requires a non-empty `traycer-tokens` query parameter. Anything
 * else (an explicit `error` parameter, a malformed URL, or a well-formed URL
 * without a usable token) collapses to the `{ error }` branch so callers
 * never need to handle a third "indeterminate" case.
 */
export function parseAuthCallback(uri: string): AuthCallbackParseResult | null {
  if (!uri.startsWith(`${PROTOCOL_SCHEME}://`)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { error: "malformed auth callback URI" };
  }

  const path = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (path !== AUTH_CALLBACK_PATH) {
    return null;
  }

  return parseAuthCallbackParams(parsed.searchParams);
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
 * Auth-callback deep links are parsed in the main process and delivered to
 * the handler as a discriminated `AuthCallbackParseResult`. The handler is
 * responsible for queueing if no renderer is ready yet (see `main/index.ts`).
 * Non-auth traycer URIs are ignored; malformed callbacks collapse to the
 * error branch.
 */
export function registerDeepLinkHandling(handler: AuthCallbackHandler): void {
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
    const result = parseAuthCallback(uri);
    if (result === null) {
      return;
    }
    // Log the parse outcome (never the code itself) so a "sign-in failed" report
    // can be traced: "received a code" followed by no `[auth] code exchange`
    // line means the renderer never reached the exchange (e.g. a missing PKCE
    // verifier on a cold-start callback), vs an exchange line that names the
    // authn-side failure.
    if ("error" in result) {
      log.warn("[deep-link] auth callback error", { error: result.error });
    } else {
      log.info("[deep-link] auth callback delivered a code to the renderer");
    }
    handler(result);
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
 * logging. The auth callback carries the bearer + refresh tokens as query
 * params (`traycer-tokens`, `traycer-refresh-token`), so logging the raw URL
 * would persist those secrets to the host/app log. Keep only the
 * scheme/host/path for diagnostics.
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
