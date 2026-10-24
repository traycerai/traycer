/**
 * Shell-agnostic client for the OAuth 2.0 Device Authorization Grant
 * (RFC 8628) endpoints in `authn-v3` (`/api/v3/auth/device/authorize` and
 * `/api/v3/auth/device/token`). Used by both the CLI process (ticket 04) and
 * the Electron main process (ticket 06), so it depends only on the ambient
 * `fetch` and carries no shell, DI, or singleton state.
 *
 * Why a dedicated client instead of `exchangeCodeForTokens`: the device-token
 * endpoint deliberately diverges from `exchange-code`. `428` and `429` are
 * *non-terminal poll states* the caller must distinguish from failure, and the
 * `400` family (`access_denied` / `expired` / `invalid_grant`) carries the
 * terminal reason in its `error` field. `exchangeCodeForTokens` collapses all
 * of these into `rejected` / `network-error`, which would make the poll loop
 * impossible to drive correctly. Every wire status therefore maps to its own
 * explicit variant here; none collapse.
 *
 * The 200 body is the same `{ token, refreshToken }` shape every mint endpoint
 * returns, so it is parsed with the shared `readRotatedTokens` helper rather
 * than a second copy of that validation.
 */
import { readRotatedTokens } from "./auth-validation";
import {
  composeRequestAbort,
  type ComposedRequestAbort,
} from "./request-abort";

export type DeviceClientId = "cli" | "desktop" | "mobile";

/**
 * Per-request cancellation + timeout for the device HTTP calls. `signal` is the
 * caller's abort (a superseded/cancelled desktop attempt, or the CLI's expiry
 * watchdog); `timeoutMs` is a hard ceiling so a stalled connection can never
 * hang the loop indefinitely - a timeout/abort surfaces as the retryable
 * `network-error` variant, identical to any other transport failure.
 *
 * Required (no optional `?:` / defaults): callers pass `signal: undefined`
 * explicitly when they have no caller-side abort to thread.
 */
export interface DeviceRequestOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

/**
 * Default per-request ceiling for a single device HTTP call. Sized well above a
 * healthy round-trip but low enough that a black-holed connection can't wedge
 * the poll loop until the device_code TTL. Callers may pass a tighter value
 * (e.g. derived from the poll interval).
 */
export const DEFAULT_DEVICE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Builds the effective abort signal for one fetch by combining the caller's
 * `signal` (if any) with a fresh per-request timeout. Returns the merged signal
 * plus a `clear` to cancel the pending timeout once the request settles so the
 * timer can't fire (or leak) after the fetch resolves.
 *
 * The composition itself lives in `request-abort.ts` because it cannot use
 * `AbortSignal.any` - that API postdates this app's iOS floor and throws
 * rather than degrading. See that module.
 */
function buildRequestSignal(
  options: DeviceRequestOptions,
): ComposedRequestAbort {
  return composeRequestAbort(options.signal ?? null, options.timeoutMs);
}

/**
 * The network errno word of a failed device request, from a fixed list: the
 * thrown error's `code` (or its `cause`'s, where undici nests it) is matched
 * against a fixed list and anything not on it is `other`. Never the message, a
 * hostname or a URL. `cert` stands for every TLS certificate verification
 * code, `tls` for every other TLS or SSL failure (a proxy that answers plain
 * HTTP, a handshake that never completes).
 *
 * A fixed list rather than any code that fits a safe charset: a `code` is a
 * free string on an object this module did not make, and a hostname fits
 * `[A-Za-z0-9_.-]` as well as an errno does.
 */
export type DeviceTransportCode =
  | "ENOTFOUND"
  | "EAI_AGAIN"
  | "ECONNREFUSED"
  | "ECONNRESET"
  | "ECONNABORTED"
  | "ETIMEDOUT"
  | "EHOSTUNREACH"
  | "ENETUNREACH"
  | "EPROTO"
  | "UND_ERR_CONNECT_TIMEOUT"
  | "UND_ERR_SOCKET"
  | "cert"
  | "tls"
  | "other";

function readThrownCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" ? code : null;
}

/**
 * Maps a thrown fetch error to its closed errno word. `cause.code` first (undici
 * throws `TypeError: fetch failed` with the errno on its `cause`), then the
 * error's own `code`. Only the code string is read, and only through the fixed
 * list or the certificate-code test below.
 */
function transportCodeOf(error: unknown): DeviceTransportCode {
  const cause: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "cause")
      : null;
  const code = readThrownCode(cause) ?? readThrownCode(error);
  if (code === null) {
    return "other";
  }
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ECONNABORTED":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EPROTO":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_SOCKET":
      return code;
    default:
      break;
  }
  if (
    code.includes("CERT") ||
    code.includes("SELF_SIGNED") ||
    code.startsWith("UNABLE_TO_VERIFY")
  ) {
    return "cert";
  }
  if (code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")) {
    return "tls";
  }
  return "other";
}

/**
 * The cause of a 200 whose body read failed before a whole body arrived. The
 * body timeout is a `timeout`; anything else is `transport` and its closed
 * word, read exactly as a thrown fetch is ({@link transportCodeOf}).
 */
function bodyReadFailureCause(error: unknown): DeviceRequestFailureCause {
  const cause: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "cause")
      : null;
  const code = readThrownCode(cause) ?? readThrownCode(error);
  if (code === "UND_ERR_BODY_TIMEOUT") return { kind: "timeout" };
  return { kind: "transport", code: transportCodeOf(error) };
}

/**
 * Why a device request (`POST /device/authorize` or one `POST /device/token`
 * poll) came back as `network-error`: a closed set of words and one number, so
 * a caller can put it in a log line (the desktop log travels in feedback
 * reports) without carrying a URL, a header or any of the response body.
 */
export type DeviceRequestFailureCause =
  | { readonly kind: "timeout" }
  | { readonly kind: "transport"; readonly code: DeviceTransportCode }
  | { readonly kind: "http-status"; readonly status: number }
  | { readonly kind: "bad-body" };

/** The log rendering of a cause: fixed words and the status number only. */
export function describeDeviceRequestFailure(
  cause: DeviceRequestFailureCause,
): string {
  switch (cause.kind) {
    case "timeout":
      return "timeout";
    case "transport":
      return `transport code=${cause.code}`;
    case "http-status":
      return `http-status status=${cause.status}`;
    case "bad-body":
      return "bad-body";
  }
}

/**
 * Result of `POST /device/authorize`. `started` carries the fields the caller
 * needs to display the verification prompt and drive the poll loop; a
 * transport failure or any non-200 is a transient `network-error` (the caller
 * may retry starting a fresh authorization). `cause` says which of those it
 * was; no caller branches on it.
 */
export type DeviceAuthorizationResult =
  | {
      readonly kind: "started";
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly verificationUriComplete: string;
      readonly expiresInSeconds: number;
      readonly intervalSeconds: number;
    }
  | {
      readonly kind: "network-error";
      readonly cause: DeviceRequestFailureCause;
    };

/**
 * Result of one `POST /device/token` poll. The variants mirror the endpoint's
 * status envelope 1:1:
 *
 *   - `authorized`            200, the minted `{ token, refreshToken }` pair
 *   - `authorization-pending` 428, user has not approved yet (keep polling)
 *   - `slow-down`             429, polling too fast (back off; honor Retry-After)
 *   - `access-denied`         400 `access_denied`, user denied (terminal)
 *   - `expired`               400 `expired`, device_code TTL elapsed (terminal)
 *   - `invalid`               400 `invalid_grant`/unknown 400 reason (terminal)
 *   - `network-error`         transport failure, 5xx or an unreadable 200
 *                             (transient; retryable); `cause` says which
 */
export type DevicePollResult =
  | {
      readonly kind: "authorized";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "authorization-pending" }
  | { readonly kind: "slow-down"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "access-denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "network-error";
      readonly cause: DeviceRequestFailureCause;
    };

/**
 * Starts a device authorization. On success the caller shows `userCode` +
 * `verificationUri` (or opens `verificationUriComplete`) and then drives
 * `pollDeviceToken` using `intervalSeconds` / `expiresInSeconds`.
 */
export async function startDeviceAuthorization(
  authnBaseUrl: string,
  params: { readonly clientId: DeviceClientId; readonly hostLabel: string },
  options: DeviceRequestOptions,
): Promise<DeviceAuthorizationResult> {
  const request = buildRequestSignal(options);
  let response: Response;
  try {
    response = await fetch(deviceApiUrl(authnBaseUrl, "authorize"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: params.clientId,
        host_label: params.hostLabel,
      }),
      signal: request.signal,
    });
  } catch (error: unknown) {
    // A caller abort or per-request timeout surfaces here too; both collapse
    // into the retryable `network-error` variant - the caller decides whether
    // to retry (poll loop) or give up (abort already consumed).
    return {
      kind: "network-error",
      cause: thrownRequestCause(request, options, error),
    };
  } finally {
    request.clear();
  }

  if (response.status !== 200) {
    return {
      kind: "network-error",
      cause: { kind: "http-status", status: response.status },
    };
  }

  const parsed = await readAuthorization(response);
  if (parsed === null) {
    return { kind: "network-error", cause: { kind: "bad-body" } };
  }
  return parsed;
}

/**
 * Polls `POST /device/token` once and maps the wire status to an explicit
 * variant. The caller loops on `authorization-pending` / `slow-down`, applies
 * a terminal state on `access-denied` / `expired` / `invalid`, and may retry
 * on `network-error` until the device_code expires.
 */
export async function pollDeviceToken(
  authnBaseUrl: string,
  deviceCode: string,
  clientId: DeviceClientId,
  options: DeviceRequestOptions,
): Promise<DevicePollResult> {
  const request = buildRequestSignal(options);
  let response: Response;
  try {
    response = await fetch(deviceApiUrl(authnBaseUrl, "token"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_code: deviceCode, client_id: clientId }),
      signal: request.signal,
    });
  } catch (error: unknown) {
    // Caller abort (superseded attempt / CLI expiry) and per-request timeout
    // both land here and map to the retryable `network-error`, so a stalled
    // `/device/token` socket can no longer wedge the poll loop. The cause is
    // read exactly as `startDeviceAuthorization` reads it.
    return {
      kind: "network-error",
      cause: thrownRequestCause(request, options, error),
    };
  } finally {
    request.clear();
  }

  if (response.status === 200) {
    const tokens = await readRotatedTokens(response);
    // A 200 whose body fails validation OR whose read aborts/times out is
    // treated as transient: the loop re-polls (and, since the server consumed
    // the code on mint, will then see a terminal `invalid`). This never silently
    // drops a real success on a momentary parse hiccup. The causes are named
    // apart: a read cut off mid-body is a `timeout` or a `transport` word, and
    // only a body that arrived and is not a token pair is `bad-body`.
    if (tokens.kind === "transient") {
      return { kind: "network-error", cause: { kind: "timeout" } };
    }
    if (tokens.kind === "invalid") {
      return {
        kind: "network-error",
        cause:
          tokens.readFailure === null
            ? { kind: "bad-body" }
            : bodyReadFailureCause(tokens.readFailure.error),
      };
    }
    return {
      kind: "authorized",
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    };
  }

  if (response.status === 428) {
    return { kind: "authorization-pending" };
  }

  if (response.status === 429) {
    return {
      kind: "slow-down",
      retryAfterSeconds: parseRetryAfterSeconds(
        response.headers.get("Retry-After"),
      ),
    };
  }

  if (response.status === 400) {
    return mapTerminalError(await readErrorCode(response));
  }

  // 5xx (e.g. Redis down) and any other unexpected status are transient.
  return {
    kind: "network-error",
    cause: { kind: "http-status", status: response.status },
  };
}

/**
 * The cause of a device request whose `fetch` threw. `timeout` is read from
 * the signals alone, never from the thrown error: the request's signal is
 * aborted and the caller's is not, so the only abort left is the per-request
 * timer. A caller abort, and anything the request failed on before either
 * signal fired, reads as `transport`; only the error's errno `code` is read,
 * against a fixed list.
 */
function thrownRequestCause(
  request: ComposedRequestAbort,
  options: DeviceRequestOptions,
  error: unknown,
): DeviceRequestFailureCause {
  const timedOut = request.signal.aborted && options.signal?.aborted !== true;
  return timedOut
    ? { kind: "timeout" }
    : { kind: "transport", code: transportCodeOf(error) };
}

/**
 * Appends this build's registered deep-link scheme to the browser verification
 * URL as `return_scheme`, so the cloud's /device approval page can deep-link
 * back to THE APP THAT ASKED - per-environment (`traycer` / `traycer-dev`) and
 * slot-suffixed under multi-run dev - instead of a hardcoded production scheme
 * (which launches an installed prod Traycer when a dev build signs in). The
 * page validates the value against a strict allowlist and fires nothing when
 * it is absent or malformed, so a manually typed verification URL simply gets
 * no return deep link. Defensive: an unparseable URL passes through untouched.
 *
 * Shared by the desktop and mobile shells; both apply it to
 * `verificationUriComplete` only - the short display URI stays clean for
 * manual entry.
 */
export function withReturnScheme(uri: string, scheme: string): string {
  try {
    const url = new URL(uri);
    url.searchParams.set("return_scheme", scheme);
    return url.toString();
  } catch {
    return uri;
  }
}

// --- Backoff helper --------------------------------------------------------

/** RFC 8628 §3.5: a `slow_down` increases the poll interval by 5 seconds. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** Floor used when the server-supplied interval is missing or nonsensical. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** Cap so a hostile/huge `interval` or `Retry-After` can't stall the loop. */
export const MAX_POLL_INTERVAL_SECONDS = 60;

/**
 * Immutable poll schedule for one device authorization. Holds the current
 * inter-poll delay (`intervalMs`), the server-issued base delay
 * (`baseIntervalMs`) the interval decays back to once polling is compliant
 * again, and the absolute deadline (`expiresAtMs`) past which the device_code
 * is dead. Pure and clock-injected (callers pass `startedAtMs` / `nowMs`) so
 * it runs identically in the CLI process, in Electron main, and in unit tests.
 */
export type DevicePollSchedule = {
  readonly intervalMs: number;
  readonly baseIntervalMs: number;
  readonly expiresAtMs: number;
};

/** Builds the initial schedule from the `/authorize` response timings. */
export function createPollSchedule(params: {
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  readonly startedAtMs: number;
}): DevicePollSchedule {
  const intervalMs = clampIntervalSeconds(params.intervalSeconds) * 1000;
  return {
    intervalMs,
    baseIntervalMs: intervalMs,
    expiresAtMs: params.startedAtMs + params.expiresInSeconds * 1000,
  };
}

/**
 * Returns a new schedule with the interval increased after a `slow-down`.
 * Honors `Retry-After` when present, but never decreases the interval and
 * always adds at least the RFC-mandated 5 seconds; the result is capped at
 * `MAX_POLL_INTERVAL_SECONDS`.
 */
export function applySlowDown(
  schedule: DevicePollSchedule,
  retryAfterSeconds: number | null,
): DevicePollSchedule {
  const currentSeconds = schedule.intervalMs / 1000;
  const incremented = currentSeconds + SLOW_DOWN_INCREMENT_SECONDS;
  const bumpedSeconds =
    retryAfterSeconds === null
      ? incremented
      : Math.max(incremented, retryAfterSeconds);
  return {
    ...schedule,
    intervalMs: clampIntervalSeconds(bumpedSeconds) * 1000,
  };
}

/**
 * Returns a schedule with the interval restored to the server-issued base.
 * Callers apply this after an `authorization-pending` response: the server
 * accepted the poll's pacing, so any earlier `slow_down` widening (e.g. from a
 * premature browser-return nudge) should not outlive the violation and keep
 * the user waiting a padded interval for the rest of the attempt.
 *
 * DELIBERATE deviation from RFC 8628 §3.5, which keeps a slow_down's +5s for
 * "all subsequent requests". This client only ever talks to Traycer's own
 * authn, whose gate is itself a fixed one-interval penalty (never ratcheting),
 * so decaying after an accepted poll mirrors the server's actual policy - and
 * without decay one spurious slow_down (e.g. clock skew between authn
 * replicas) would pin a widened interval for the attempt's remaining life,
 * delaying approval detection for clients with no browser-return nudge (CLI).
 */
export function resetPollInterval(
  schedule: DevicePollSchedule,
): DevicePollSchedule {
  return { ...schedule, intervalMs: schedule.baseIntervalMs };
}

/** Whether the device_code has expired as of `nowMs`. */
export function isDeviceExpired(
  schedule: DevicePollSchedule,
  nowMs: number,
): boolean {
  return nowMs >= schedule.expiresAtMs;
}

function clampIntervalSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  return Math.min(Math.max(Math.ceil(seconds), 1), MAX_POLL_INTERVAL_SECONDS);
}

// --- Internal parsing helpers ----------------------------------------------

function mapTerminalError(errorCode: string | null): DevicePollResult {
  switch (errorCode) {
    case "access_denied":
      return { kind: "access-denied" };
    case "expired":
      return { kind: "expired" };
    default:
      // `invalid_grant` and any other 400 reason are terminal-but-unspecified.
      // Crucially this is NOT collapsed into `network-error`: a 400 means the
      // request itself is dead, not that the network is flaky.
      return { kind: "invalid" };
  }
}

async function readAuthorization(
  response: Response,
): Promise<DeviceAuthorizationResult | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") {
    return null;
  }

  const record = body as Record<string, unknown>;
  const deviceCode = pickNonEmptyString(record, "device_code");
  const userCode = pickNonEmptyString(record, "user_code");
  const verificationUri = pickHttpUrl(record, "verification_uri");
  const verificationUriComplete = pickHttpUrl(
    record,
    "verification_uri_complete",
  );
  const expiresInSeconds = pickPositiveInt(record, "expires_in");
  const intervalSeconds = pickPositiveInt(record, "interval");

  if (
    deviceCode === null ||
    userCode === null ||
    verificationUri === null ||
    verificationUriComplete === null ||
    expiresInSeconds === null ||
    intervalSeconds === null
  ) {
    return null;
  }

  return {
    kind: "started",
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds,
    intervalSeconds,
  };
}

async function readErrorCode(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") {
    return null;
  }
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" ? error : null;
}

/**
 * Parses a `Retry-After` header value. The poll endpoints only ever emit
 * integer seconds, so the HTTP-date form is intentionally not handled; an
 * absent or unparseable value yields `null` and the caller falls back to its
 * own backoff increment. Returning `null` rather than a number is the whole
 * point: a numeric fallback of zero reads as "retry immediately", which is
 * the opposite of what a 429 asked for.
 *
 * Shared with the link-login poll client, whose 429s come from the same two
 * sources (a paced record throttle and a request budget).
 */
export function parseRetryAfterSeconds(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.ceil(seconds);
}

function deviceApiUrl(
  authnBaseUrl: string,
  endpoint: "authorize" | "token",
): string {
  return new URL(
    `api/v3/auth/device/${endpoint}`,
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

function pickNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Like `pickNonEmptyString`, but additionally requires the value to parse as an
 * absolute `http`/`https` URL. The verification URIs come straight from the
 * server response and are opened in the user's browser, so a non-http(s) scheme
 * (`file:`, `javascript:`, ...) must be rejected as an invalid authorization
 * body rather than handed to the platform opener.
 */
function pickHttpUrl(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = pickNonEmptyString(record, key);
  if (value === null) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return value;
}

function pickPositiveInt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  // Require a positive integer: flooring a fractional value would accept a
  // malformed `expires_in: 0.5` as `0` (instant expiry) instead of rejecting the
  // `/device/authorize` body as invalid.
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
