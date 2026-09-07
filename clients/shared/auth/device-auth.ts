/**
 * Shell-agnostic client for the OAuth 2.0 Device Authorization Grant (rfc 8628) endpoints in `authn-v3` (`/api/v3/auth/device/authorize` and `/api/v3/auth/device/token`).
 * Why a dedicated client instead of `exchangeCodeForTokens`: the device-token endpoint deliberately diverges from `exchange-code`.
 */
import { readRotatedTokens } from "./auth-validation";
import {
  composeRequestAbort,
  type ComposedRequestAbort,
} from "./request-abort";

export type DeviceClientId = "cli" | "desktop" | "mobile";

export interface DeviceRequestOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

/**
 * Default per-request ceiling for a single device HTTP call.
 * Sized well above a healthy round-trip but low enough that a black-holed connection can't wedge the poll loop until the device_code ttl.
 */
export const DEFAULT_DEVICE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Builds the effective abort signal for one fetch by combining the caller's `signal` (if any) with a fresh per-request timeout.
 * Returns the merged signal plus a `clear` to cancel the pending timeout once the request settles so the timer can't fire (or leak) after the fetch resolves.
 */
function buildRequestSignal(
  options: DeviceRequestOptions,
): ComposedRequestAbort {
  return composeRequestAbort(options.signal ?? null, options.timeoutMs);
}

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
    // A caller abort or per-request timeout surfaces here too; both collapse into the retryable `network-error` variant - the caller decides whether to retry (poll loop) or give up (abort already consumed).
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
    // Caller abort (superseded attempt / CLI expiry) and per-request timeout both land here and map to the retryable `network-error`, so a stalled `/device/token` socket can no longer wedge the poll loop.
    return { kind: "network-error" };
  } finally {
    request.clear();
  }

  if (response.status === 200) {
    const tokens = await readRotatedTokens(response);
    // A 200 whose body fails validation OR whose read aborts/times out is treated as transient: the loop re-polls (and, since the server consumed the code on mint, will then see a terminal `invalid`).
    // This never silently drops a real success on a momentary parse hiccup.
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

/**
 * The page validates the value against a strict allowlist and fires nothing when it is absent or malformed, so a manually typed verification URL simply gets no return deep link.
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

const SLOW_DOWN_INCREMENT_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** Cap so a hostile/huge `interval` or `Retry-After` can't stall the loop. */
export const MAX_POLL_INTERVAL_SECONDS = 60;

export type DevicePollSchedule = {
  readonly intervalMs: number;
  readonly baseIntervalMs: number;
  readonly expiresAtMs: number;
};

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
 * Honors `Retry-After` when present, but never decreases the interval and always adds at least the rfc-mandated 5 seconds; the result is capped at `MAX_POLL_INTERVAL_SECONDS`.
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

export function resetPollInterval(
  schedule: DevicePollSchedule,
): DevicePollSchedule {
  return { ...schedule, intervalMs: schedule.baseIntervalMs };
}

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
 * Parses a `Retry-After` header value.
 * The poll endpoints only ever emit integer seconds, so the HTTP-date form is intentionally not handled; an absent or unparseable value yields `null` and the caller falls back to its own backoff increment.
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
  // Require a positive integer: flooring a fractional value would accept a malformed `expires_in: 0.5` as `0` (instant expiry) instead of rejecting the `/device/authorize` body as invalid.
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
