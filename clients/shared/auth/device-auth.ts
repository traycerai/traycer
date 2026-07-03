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

export type DeviceClientId = "cli" | "desktop";

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
 */
function buildRequestSignal(options: DeviceRequestOptions): {
  readonly signal: AbortSignal;
  readonly clear: () => void;
} {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  const clear = (): void => clearTimeout(timer);
  if (options.signal === undefined) {
    return { signal: timeoutController.signal, clear };
  }
  return {
    signal: AbortSignal.any([options.signal, timeoutController.signal]),
    clear,
  };
}

/**
 * Result of `POST /device/authorize`. `started` carries the fields the caller
 * needs to display the verification prompt and drive the poll loop; a
 * transport failure or any non-200 is a transient `network-error` (the caller
 * may retry starting a fresh authorization).
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
  | { readonly kind: "network-error" };

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
 *   - `network-error`         transport failure or 5xx (transient; retryable)
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
  | { readonly kind: "network-error" };

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
  } catch {
    // A caller abort or per-request timeout surfaces here too; both collapse
    // into the retryable `network-error` variant - the caller decides whether
    // to retry (poll loop) or give up (abort already consumed).
    return { kind: "network-error" };
  } finally {
    request.clear();
  }

  if (response.status !== 200) {
    return { kind: "network-error" };
  }

  const parsed = await readAuthorization(response);
  if (parsed === null) {
    return { kind: "network-error" };
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
  } catch {
    // Caller abort (superseded attempt / CLI expiry) and per-request timeout
    // both land here and map to the retryable `network-error`, so a stalled
    // `/device/token` socket can no longer wedge the poll loop.
    return { kind: "network-error" };
  } finally {
    request.clear();
  }

  if (response.status === 200) {
    const tokens = await readRotatedTokens(response);
    // A 200 whose body fails validation OR whose read aborts/times out is
    // treated as transient: the loop re-polls (and, since the server consumed
    // the code on mint, will then see a terminal `invalid`). This never silently
    // drops a real success on a momentary parse hiccup.
    if (tokens.kind !== "ok") {
      return { kind: "network-error" };
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
  return { kind: "network-error" };
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
 * inter-poll delay (`intervalMs`) and the absolute deadline (`expiresAtMs`)
 * past which the device_code is dead. Pure and clock-injected (callers pass
 * `startedAtMs` / `nowMs`) so it runs identically in the CLI process, in
 * Electron main, and in unit tests.
 */
export type DevicePollSchedule = {
  readonly intervalMs: number;
  readonly expiresAtMs: number;
};

/** Builds the initial schedule from the `/authorize` response timings. */
export function createPollSchedule(params: {
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  readonly startedAtMs: number;
}): DevicePollSchedule {
  return {
    intervalMs: clampIntervalSeconds(params.intervalSeconds) * 1000,
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
 * Parses a `Retry-After` header value. The device-token endpoint only ever
 * emits integer seconds, so the HTTP-date form is intentionally not handled;
 * an absent or unparseable value yields `null` and the caller falls back to
 * its own backoff increment.
 */
function parseRetryAfterSeconds(header: string | null): number | null {
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
