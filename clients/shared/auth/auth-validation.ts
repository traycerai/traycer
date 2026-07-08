/**
 * Stateless boundary helpers that turn a raw bearer token into either a
 * narrow runner-host profile (for `IRunnerHost.validateAuthToken(...)`) or a
 * full `AuthenticatedUser` identity (for minting a `RequestContext`).
 *
 * Lives under `shared/auth/` because it is the auth-boundary conversion
 * point: raw bearer strings are allowed here only inside validation/refresh
 * helpers, and everything past the boundary trades them for a
 * `RequestContext`. Keeping these helpers stateless and platform-neutral
 * means they can run from Electron main, mobile native, browser preview,
 * or unit tests without any DI or singleton state.
 *
 * Two parallel surfaces are exported:
 *
 *   - `validateAuthTokenViaHttp(...)` returns a narrow `AuthValidationProfile`
 *     for the existing `IRunnerHost` IPC contract; this shape MUST stay
 *     wire-compatible with desktop/mobile shells that already consume it.
 *   - `validateAuthTokenIdentityViaHttp(...)` returns the full
 *     `AuthenticatedUser` so the client `RequestContextProvider` (and its
 *     host-equivalent boundary helper) can mint a context with the same
 *     identity shape that host-minted contexts already carry.
 *
 * Both surfaces share a single one-shot refresh attempt on a failed user
 * lookup so the same retry semantics apply on either return shape.
 */
import { authRecordRegistry } from "@traycer/protocol/auth/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import type {
  AuthTokenRefreshResult,
  AuthTokenValidationResult,
  AuthValidationProfile,
} from "../platform/runner-host";
import type { AuthIdentityValidationResult } from "./auth-validation-types";

export type {
  AuthIdentityValidationResult,
  AuthIdentityValidResult,
} from "./auth-validation-types";
export type { AuthTokenRefreshResult } from "../platform/runner-host";

const authenticatedUserResponseSchema = getRecordSchema(
  authRecordRegistry,
  "authenticated-user-response",
  "latest",
);

/**
 * Per-attempt ceiling and bounded exponential-backoff retry for the auth
 * boundary's HTTP calls (`/api/v3/user`, `/api/v3/auth/refresh`).
 *
 * Every attempt is time-boxed with `AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS)`
 * so a stalled/half-open socket can no longer hang the caller indefinitely -
 * previously an un-timed-out `fetch` here could block `auth.start()` (and, through
 * it, the renderer's "Initializing Traycer Host…" gate) until the OS TCP timeout,
 * i.e. many minutes. A fired timeout rejects the `fetch`, which the surrounding
 * `catch` already collapses to `network-error`; that outcome (plus a 5xx or a 409
 * refresh-grace race) is the only one re-driven. A terminal `rejected`/`valid`
 * returns on the first attempt.
 *
 * Total wall-clock is bounded to `AUTH_FETCH_MAX_ATTEMPTS` attempts spaced by an
 * exponential backoff capped at `AUTH_FETCH_RETRY_MAX_DELAY_MS`.
 */
export const AUTH_FETCH_MAX_ATTEMPTS = 3;
const AUTH_FETCH_TIMEOUT_MS = 10_000;
const AUTH_FETCH_RETRY_BASE_DELAY_MS = 500;
const AUTH_FETCH_RETRY_MAX_DELAY_MS = 4_000;

/**
 * Runs `attempt`, then re-drives it while `isTransient(outcome)` holds, up to
 * `AUTH_FETCH_MAX_ATTEMPTS` total invocations. Never throws: `attempt` is a
 * boundary helper that already maps every transport failure (including a fired
 * per-attempt timeout) to a typed outcome, so there is nothing to catch here.
 */
async function withAuthNetworkRetry<T>(
  attempt: () => Promise<T>,
  isTransient: (outcome: T) => boolean,
): Promise<T> {
  let outcome = await attempt();
  for (
    let retry = 1;
    retry < AUTH_FETCH_MAX_ATTEMPTS && isTransient(outcome);
    retry += 1
  ) {
    await delayFor(authRetryDelayMs(retry));
    outcome = await attempt();
  }
  return outcome;
}

function authRetryDelayMs(retry: number): number {
  const candidate = AUTH_FETCH_RETRY_BASE_DELAY_MS * 2 ** (retry - 1);
  return Math.min(candidate, AUTH_FETCH_RETRY_MAX_DELAY_MS);
}

function delayFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True for an abort/timeout thrown while reading a response body *after* the
 * headers arrived - the per-attempt `AbortSignal.timeout` (a `TimeoutError`) or
 * a caller abort (`AbortError`) firing during `response.json()`. Such a failure
 * is transient/retriable and must surface as `network-error`, NOT be collapsed
 * into a terminal `rejected`/invalid body the way a genuine parse failure is.
 */
function isAbortOrTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Shared bearer-token validation helper used by runner-host implementations.
 *
 * Browser-only hosts (tests, preview, mobile webview) call this directly with
 * the ambient `fetch`. Desktop shells use the same parser in Electron main so
 * the GUI receives the exact same validation semantics without renderer CORS
 * involvement. A failed user lookup is refreshed once before the helper
 * returns a terminal failure.
 */
export async function validateAuthTokenViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
): Promise<AuthTokenValidationResult> {
  const initial = await validateAuthTokenProfileViaHttp(authnBaseUrl, token);
  if (initial.kind === "valid") {
    return initial;
  }

  const refresh = await refreshAuthTokenViaHttp(
    authnBaseUrl,
    token,
    refreshToken,
  );
  if (refresh.kind !== "refreshed") {
    // A confirmed rejection from the initial lookup wins over a refresh error:
    // a `5xx`/network failure on `/api/v3/auth/refresh` must not downgrade a known
    // `rejected` token to `network-error`. Only a genuinely transient initial
    // lookup (no prior rejection) stays `network-error`.
    return initial.kind === "rejected" ? initial : refresh;
  }

  const refreshed = await validateAuthTokenProfileViaHttp(
    authnBaseUrl,
    refresh.token,
  );
  if (refreshed.kind !== "valid") {
    return refreshed;
  }

  return {
    ...refreshed,
    refreshedToken: refresh.token,
    refreshedRefreshToken: refresh.refreshToken,
  };
}

/**
 * Full-identity counterpart to `validateAuthTokenViaHttp(...)`. Returns the
 * complete `AuthenticatedUser` so the client `RequestContextProvider` can
 * mint a context whose `identity.user` matches the host-minted shape.
 *
 * Refresh-on-401 behaviour is identical to the narrow-profile helper: a
 * single refresh attempt happens before a terminal `rejected`/`network-error`
 * is surfaced, and a successful refresh is reported via `refreshedToken`.
 */
export async function validateAuthTokenIdentityViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
): Promise<AuthIdentityValidationResult> {
  const initial = await validateAuthTokenIdentityFetch(authnBaseUrl, token);
  if (initial.kind === "valid") {
    return initial;
  }

  const refresh = await refreshAuthTokenViaHttp(
    authnBaseUrl,
    token,
    refreshToken,
  );
  if (refresh.kind !== "refreshed") {
    // A confirmed rejection from the initial lookup wins over a refresh error:
    // a `5xx`/network failure on `/api/v3/auth/refresh` must not downgrade a known
    // `rejected` token to `network-error`. Only a genuinely transient initial
    // lookup (no prior rejection) stays `network-error`.
    return initial.kind === "rejected" ? initial : refresh;
  }

  const refreshed = await validateAuthTokenIdentityFetch(
    authnBaseUrl,
    refresh.token,
  );
  if (refreshed.kind !== "valid") {
    return refreshed;
  }

  return {
    ...refreshed,
    refreshedToken: refresh.token,
    refreshedRefreshToken: refresh.refreshToken,
  };
}

async function validateAuthTokenProfileViaHttp(
  authnBaseUrl: string,
  token: string,
): Promise<AuthTokenValidationResult> {
  const result = await fetchUserResponse(authnBaseUrl, token);
  if (result.kind !== "ok") {
    return result.result;
  }

  const profile = projectProfile(result.body);
  if (profile === null) {
    return { kind: "rejected" };
  }
  return { kind: "valid", profile };
}

async function validateAuthTokenIdentityFetch(
  authnBaseUrl: string,
  token: string,
): Promise<AuthIdentityValidationResult> {
  const result = await fetchUserResponse(authnBaseUrl, token);
  if (result.kind !== "ok") {
    return result.result;
  }

  const parsed = authenticatedUserResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: "rejected" };
  }
  return { kind: "valid", user: parsed.data };
}

type UserFetchResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | {
      readonly kind: "failed";
      readonly result:
        { readonly kind: "rejected" } | { readonly kind: "network-error" };
    };

async function fetchUserResponse(
  authnBaseUrl: string,
  token: string,
): Promise<UserFetchResult> {
  return withAuthNetworkRetry(
    () => fetchUserResponseOnce(authnBaseUrl, token),
    isUserFetchTransient,
  );
}

function isUserFetchTransient(result: UserFetchResult): boolean {
  return result.kind === "failed" && result.result.kind === "network-error";
}

async function fetchUserResponseOnce(
  authnBaseUrl: string,
  token: string,
): Promise<UserFetchResult> {
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, "api/v3/user"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
  } catch {
    // A thrown `fetch` - a transport failure OR the per-attempt
    // `AbortSignal.timeout` firing (a `TimeoutError`) - is transient and
    // retriable, so both collapse to `network-error`.
    return { kind: "failed", result: { kind: "network-error" } };
  }

  if (response.status === 401 || response.status === 404) {
    return { kind: "failed", result: { kind: "rejected" } };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", result: { kind: "network-error" } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A timeout/abort firing mid-body-read (after headers) is transient, not a
    // dead credential - classify it like a pre-headers abort. A genuinely
    // malformed 2xx body stays `rejected`.
    if (isAbortOrTimeout(error)) {
      return { kind: "failed", result: { kind: "network-error" } };
    }
    return { kind: "failed", result: { kind: "rejected" } };
  }
  return { kind: "ok", body };
}

/**
 * Token refresh against the authn service's `/api/v3/auth/refresh` endpoint.
 * Post raw-JWS cutover the access token (`token`, the bearer) and the
 * `refreshToken` are separate: the bearer goes in the `Authorization` header and
 * the `refreshToken` in the request body (the endpoint requires it). A success
 * rotates BOTH, so we return the new `{ token, refreshToken }` for the caller to
 * persist. Exported so the CLI's host-auth boundary can refresh a stale bearer
 * on a host `401` without re-running a full `/api/v3/user` validation round trip.
 *
 * Each attempt is time-boxed by `AbortSignal.timeout` and transient outcomes
 * (transport failure, timeout, 5xx, or a 409 grace-window race) are retried on a
 * bounded exponential backoff via {@link withAuthNetworkRetry}; a `rejected`
 * (dead credential) returns on the first attempt. Replaying the same
 * `refreshToken` on a retry is safe: if the prior attempt's write was lost the
 * authn grace window replays the winner's rotated pair (the 409 path).
 */
export async function refreshAuthTokenViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
): Promise<AuthTokenRefreshResult> {
  return withAuthNetworkRetry(
    () => refreshAuthTokenOnceViaHttp(authnBaseUrl, token, refreshToken),
    isRefreshTransient,
  );
}

function isRefreshTransient(result: AuthTokenRefreshResult): boolean {
  return result.kind === "network-error";
}

async function refreshAuthTokenOnceViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
): Promise<AuthTokenRefreshResult> {
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, "api/v3/auth/refresh"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "network-error" };
  }

  // A 409 means the authn refresh grace window is mid-rotation: a concurrent
  // refresher won the race and is minting the new pair. This is transient and
  // retriable, NOT a dead credential, so map it to `network-error` (a retry
  // re-drives and lands on the winner's replayed pair) rather than `rejected`,
  // which would sign the GUI out.
  if (response.status === 409) {
    return { kind: "network-error" };
  }

  if (
    response.status === 400 ||
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return { kind: "rejected" };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }

  const rotated = await readRotatedTokens(response);
  if (rotated.kind === "transient") {
    return { kind: "network-error" };
  }
  if (rotated.kind === "invalid") {
    return { kind: "rejected" };
  }
  return {
    kind: "refreshed",
    token: rotated.token,
    refreshToken: rotated.refreshToken,
  };
}

export type AuthCodeExchangeResult =
  | {
      readonly kind: "exchanged";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

/**
 * Exchanges a one-time PKCE `code` + `codeVerifier` for the token pair at
 * `/api/v3/auth/exchange-code`. The shell calls this at its sign-in callback with
 * the verifier it generated (and kept in-memory) at sign-in start. Public
 * endpoint - no bearer; the code is the credential.
 *
 * A `4xx` is a terminal `rejected` (bad/expired/used code, or a PKCE mismatch);
 * any other non-2xx or a transport failure is a transient `network-error`. The
 * request is time-boxed by `AbortSignal.timeout` (a fired timeout surfaces as
 * `network-error` via the `catch`); unlike validation/refresh it is deliberately
 * NOT retried, because the `code` is single-use - replaying it after a lost
 * response would be rejected as already-consumed. The sign-in callback surfaces
 * the `network-error` as a retry CTA instead.
 */
export async function exchangeCodeForTokens(
  authnBaseUrl: string,
  code: string,
  codeVerifier: string,
): Promise<AuthCodeExchangeResult> {
  let response: Response;
  try {
    response = await fetch(
      authnApiUrl(authnBaseUrl, "api/v3/auth/exchange-code"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      },
    );
  } catch {
    return { kind: "network-error" };
  }

  if (
    response.status === 400 ||
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return { kind: "rejected" };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }

  const tokens = await readRotatedTokens(response);
  if (tokens.kind === "transient") {
    return { kind: "network-error" };
  }
  if (tokens.kind === "invalid") {
    return { kind: "rejected" };
  }
  return {
    kind: "exchanged",
    token: tokens.token,
    refreshToken: tokens.refreshToken,
  };
}

function projectProfile(body: unknown): AuthValidationProfile | null {
  if (body === null || typeof body !== "object") {
    return null;
  }

  const user = (body as Record<string, unknown>).user;
  if (user === null || typeof user !== "object") {
    return null;
  }

  const record = user as Record<string, unknown>;
  const email = pickString(record, "email");
  const userName =
    pickString(record, "name", "providerHandle") ?? emailLocalPart(email);
  const userId = pickString(record, "id");
  if (userName === null && email === null && userId === null) {
    return null;
  }

  return {
    userId: userId ?? "",
    userName: userName ?? "",
    email: email ?? "",
  };
}

/**
 * Outcome of reading the rotated `{ token, refreshToken }` pair from a 2xx
 * token-mint body:
 *   - `ok`        - a valid non-empty pair;
 *   - `invalid`   - the body is malformed or missing a field (terminal);
 *   - `transient` - the body read was aborted/timed out after headers arrived
 *                   (retriable; must NOT be treated as a bad body).
 */
export type RotatedTokensOutcome =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "transient" };

/**
 * Parses the rotated `{ token, refreshToken }` pair from a 2xx token-mint
 * response body. Exported so the device-flow client (`device-auth.ts`) can
 * reuse the exact same 200-body shape that `exchange-code` / `refresh` use,
 * without duplicating the field validation. A body-read abort/timeout is
 * reported as `transient` so callers keep it retriable instead of collapsing it
 * into a terminal bad-body outcome; a malformed/missing-field body is `invalid`.
 */
export async function readRotatedTokens(
  response: Response,
): Promise<RotatedTokensOutcome> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return isAbortOrTimeout(error)
      ? { kind: "transient" }
      : { kind: "invalid" };
  }

  if (body === null || typeof body !== "object") {
    return { kind: "invalid" };
  }

  const record = body as Record<string, unknown>;
  const token = record.token;
  const refreshToken = record.refreshToken;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    return { kind: "invalid" };
  }

  return { kind: "ok", token, refreshToken };
}

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path,
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

function pickString(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function emailLocalPart(email: string | null): string | null {
  if (email === null) {
    return null;
  }

  const atIndex = email.indexOf("@");
  if (atIndex <= 0) {
    return null;
  }

  return email.slice(0, atIndex);
}
