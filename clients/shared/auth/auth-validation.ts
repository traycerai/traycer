/**
 * Stateless boundary helpers that turn a raw bearer token into a full
 * `AuthenticatedUser` identity, refresh a token pair, or exchange a PKCE code.
 *
 * Lives under `shared/auth/` because it is the auth-boundary conversion
 * point: raw bearer strings are allowed here only inside validation/refresh
 * helpers, and everything past the boundary trades them for a
 * `RequestContext`. Keeping these helpers stateless and platform-neutral
 * means they can run from Electron main, mobile native, browser preview,
 * or unit tests without any DI or singleton state.
 *
 * Validation is ACCESS-ONLY (credentials-file token-store tech plan §3): the
 * `validateAuthTokenIdentity*` helpers do a single `/api/v3/user` lookup with NO
 * refresh-on-401, so they can never spend a refresh token. Every *spend* runs
 * inside the credentials file lock via the mutation store's `rotate`, which
 * injects the single-attempt `refreshOnceAbortable` below as its `RefreshFn`.
 */
import { authRecordRegistry } from "@traycer/protocol/auth/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  AuthTokenRefreshResult,
  StoredCredentials,
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
 * Access-only full-identity validation (credentials-file token-store tech plan
 * §3): a single `/api/v3/user` lookup with NO refresh-on-401 fallback, so it can
 * never spend a refresh token. This is the validator the desktop renderer's
 * `AuthService` uses everywhere it checks a bearer (startup rehydration, reactive
 * 401 revalidation, device-flow finalization, cross-window projection): a stale
 * access token comes back `rejected`/`network-error` and the caller routes the
 * *spend* through the locked `rotate` op instead. `valid` never carries a
 * `refreshedToken` — the pair on hand is unchanged.
 */
export function validateAuthTokenIdentityAccessOnly(
  authnBaseUrl: string,
  token: string,
): Promise<AuthIdentityValidationResult> {
  return validateAuthTokenIdentityFetch(authnBaseUrl, token);
}

/**
 * Single-attempt, ~10s, abort-aware access-only identity probe — the migration
 * counterpart to {@link validateAuthTokenIdentityAccessOnly} (tech plan §6).
 * ONE `/api/v3/user` lookup with NO refresh-on-401 (never spends) and NO internal
 * retry: the migration state machine owns bounded re-entry and threads its
 * deadline `signal` through here, so a slow probe cannot outlive the migration
 * budget or blur its "L unspent" accounting the way the 3×10s stack would. The
 * `signal` is combined with a fresh ~10s timeout (à la {@link refreshOnceAbortable});
 * either firing collapses to `network-error`.
 */
export async function validateAuthTokenIdentityAccessOnceAbortable(args: {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly signal: AbortSignal | null;
}): Promise<AuthIdentityValidationResult> {
  const timeout = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  const signal =
    args.signal === null ? timeout : AbortSignal.any([args.signal, timeout]);
  const result = await fetchUserResponseOnce(
    args.authnBaseUrl,
    args.token,
    signal,
  );
  if (result.kind !== "ok") {
    return result.result;
  }
  const parsed = authenticatedUserResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: "rejected" };
  }
  return { kind: "valid", user: parsed.data };
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

/**
 * Projects a validated `AuthenticatedUser` onto the `StoredCredentials.user`
 * identity block persisted in the credentials file. Shared so the device-flow
 * sign-in (renderer) and the §6 migration `/user` probe (main) stamp identical
 * identity shapes; `email`/`name` fall back exactly as the file's decoder
 * tolerates.
 *
 * NB: distinct from protocol's `identityFromAuthenticatedUser`, which projects
 * onto the `AuthenticatedIdentity` (`{ userId, username, providerHandle }`) a
 * `RequestContext` carries — a different shape for a different consumer.
 */
export function credentialsIdentityFromAuthenticatedUser(
  user: AuthenticatedUser,
): StoredCredentials["user"] {
  return {
    id: user.user.id,
    email: user.user.email ?? "",
    name: user.user.name ?? user.user.providerHandle,
  };
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
    () =>
      fetchUserResponseOnce(
        authnBaseUrl,
        token,
        AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      ),
    isUserFetchTransient,
  );
}

function isUserFetchTransient(result: UserFetchResult): boolean {
  return result.kind === "failed" && result.result.kind === "network-error";
}

async function fetchUserResponseOnce(
  authnBaseUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<UserFetchResult> {
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, "api/v3/user"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal,
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
 * Single-attempt, ~10s, abort-aware refresh — the exact shape the credentials
 * mutation store injects as its `RefreshFn` (tech plan §2/§3). It makes ONE
 * bounded attempt so it fits the "at most one refresh per lock hold" budget: the
 * locked rotate holds the credentials lock across this call, so a multi-attempt
 * helper would blow the lock hold time and starve a competing sign-out. The
 * caller's `signal` (the rotate/migration `AbortSignal`) is combined with a fresh
 * ~10s timeout, so either the caller aborting or the deadline firing collapses to
 * `network-error` (nothing spent — the retry re-enters under a fresh lock).
 */
export async function refreshOnceAbortable(args: {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal | null;
}): Promise<AuthTokenRefreshResult> {
  const timeout = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  const signal =
    args.signal === null ? timeout : AbortSignal.any([args.signal, timeout]);
  return refreshAuthTokenOnceViaHttp(
    args.authnBaseUrl,
    args.token,
    args.refreshToken,
    signal,
  );
}

async function refreshAuthTokenOnceViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
  signal: AbortSignal,
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
      signal,
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
