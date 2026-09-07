/**
 * Stateless boundary helpers that turn a raw bearer token into a full `AuthenticatedUser` identity, refresh a token pair, or exchange a PKCE code.
 * Keeping these helpers stateless and platform-neutral means they can run from Electron main, mobile native, browser preview, or unit tests without any DI or singleton state.
 */
import { authRecordRegistry } from "@traycer/protocol/auth/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  AuthTokenRefreshResult,
  StoredCredentials,
} from "../platform/runner-host";
import type {
  AuthIdentityValidationResult,
  AuthServerTimeObservation,
} from "./auth-validation-types";

export type {
  AuthIdentityValidationResult,
  AuthIdentityValidResult,
  AuthServerTimeObservation,
} from "./auth-validation-types";
export type { AuthTokenRefreshResult } from "../platform/runner-host";

const authenticatedUserResponseSchema = getRecordSchema(
  authRecordRegistry,
  "authenticated-user-response",
  "latest",
);

/**
 * Per-attempt ceiling and bounded exponential-backoff retry for the auth boundary's HTTP calls (`/api/v3/user`, `/api/v3/auth/refresh`).
 * A fired timeout rejects the `fetch`, which the surrounding `catch` already collapses to `network-error`; that outcome (plus a 5xx or a 409 refresh-grace race) is the only one re-driven.
 */
export const AUTH_FETCH_MAX_ATTEMPTS = 3;
const AUTH_FETCH_TIMEOUT_MS = 10_000;
const AUTH_FETCH_RETRY_BASE_DELAY_MS = 500;
const AUTH_FETCH_RETRY_MAX_DELAY_MS = 4_000;

/**
 * Runs `attempt`, then re-drives it while `isTransient(outcome)` holds, up to `AUTH_FETCH_MAX_ATTEMPTS` total invocations.
 * Never throws: `attempt` is a boundary helper that already maps every transport failure (including a fired per-attempt timeout) to a typed outcome, so there is nothing to catch here.
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

export function authRetryDelayMs(retry: number): number {
  const candidate = AUTH_FETCH_RETRY_BASE_DELAY_MS * 2 ** (retry - 1);
  return Math.min(candidate, AUTH_FETCH_RETRY_MAX_DELAY_MS);
}

function delayFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True for an abort/timeout thrown while reading a response body *after* the headers arrived - the per-attempt `AbortSignal.timeout` (a `TimeoutError`) or a caller abort (`AbortError`) firing during `response.json()`.
 * Such a failure is transient/retriable and must surface as `network-error`, not be collapsed into a terminal `rejected`/invalid body the way a genuine parse failure is.
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
 * Access-only full-identity validation (credentials-file token-store tech plan §3): a single `/api/v3/user` lookup with NO refresh-on-401 fallback, so it can never spend a refresh token.
 * `valid` never carries a `refreshedToken` - the pair on hand is unchanged.
 */
export function validateAuthTokenIdentityAccessOnly(
  authnBaseUrl: string,
  token: string,
): Promise<AuthIdentityValidationResult> {
  return validateAuthTokenIdentityFetch(authnBaseUrl, token);
}

/**
 * Single-attempt, ~10s, abort-aware access-only identity probe - the migration counterpart to {@link validateAuthTokenIdentityAccessOnly} (tech plan §6).
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
  return toIdentityValidationResult(result);
}

async function validateAuthTokenIdentityFetch(
  authnBaseUrl: string,
  token: string,
): Promise<AuthIdentityValidationResult> {
  return toIdentityValidationResult(
    await fetchUserResponse(authnBaseUrl, token),
  );
}

/**
 * Projects a `/api/v3/user` fetch onto the caller-facing result, re-attaching the response's server-time observation to every outcome that had one.
 */
function toIdentityValidationResult(
  result: UserFetchResult,
): AuthIdentityValidationResult {
  const serverTime = serverTimeFields(result.serverTime);
  if (result.kind !== "ok") {
    return result.result.kind === "rejected"
      ? { kind: "rejected", ...serverTime }
      : { kind: "network-error" };
  }
  const parsed = authenticatedUserResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: "rejected", ...serverTime };
  }
  return { kind: "valid", user: parsed.data, ...serverTime };
}

/**
 * Spreads to nothing when there is no observation, so an absent `Date` header
 * leaves the property off entirely rather than setting it to `undefined`.
 */
function serverTimeFields(serverTime: AuthServerTimeObservation | null): {
  readonly serverTime?: AuthServerTimeObservation;
} {
  return serverTime === null ? {} : { serverTime };
}

/**
 * Reads the response's HTTP `Date` header as a server-time sample, paired with the local clock right now.
 * Opportunistic: an absent or unparseable header yields `null`, never a guess.
 */
function readServerTimeObservation(
  response: Response,
): AuthServerTimeObservation | null {
  const header = response.headers.get("date");
  if (header === null) {
    return null;
  }
  const serverEpochMs = Date.parse(header);
  if (Number.isNaN(serverEpochMs)) {
    return null;
  }
  return { serverEpochMs, observedAtMs: Date.now() };
}

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
  | {
      readonly kind: "ok";
      readonly body: unknown;
      readonly serverTime: AuthServerTimeObservation | null;
    }
  | {
      readonly kind: "failed";
      readonly result:
        | { readonly kind: "rejected" }
        | { readonly kind: "network-error" };
      // `null` whenever no response arrived (transport failure / timeout) or
      // the response carried no usable `Date`.
      readonly serverTime: AuthServerTimeObservation | null;
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
    // A thrown `fetch` - a transport failure OR the per-attempt `AbortSignal.timeout` firing (a `TimeoutError`) - is transient and retriable, so both collapse to `network-error`.
    return {
      kind: "failed",
      result: { kind: "network-error" },
      serverTime: null,
    };
  }

  // Read before any status branching: a 401 response is a server-time sample exactly as good as a 200, and it is the one a badly skewed client actually gets back.
  const serverTime = readServerTimeObservation(response);

  if (response.status === 401 || response.status === 404) {
    return { kind: "failed", result: { kind: "rejected" }, serverTime };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", result: { kind: "network-error" }, serverTime };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A timeout/abort firing mid-body-read (after headers) is transient, not a dead credential - classify it like a pre-headers abort.
    if (isAbortOrTimeout(error)) {
      return { kind: "failed", result: { kind: "network-error" }, serverTime };
    }
    return { kind: "failed", result: { kind: "rejected" }, serverTime };
  }
  return { kind: "ok", body, serverTime };
}

export async function refreshOnceAbortable(args: {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly clientKind: "cli" | "desktop" | null;
  readonly signal: AbortSignal | null;
}): Promise<AuthTokenRefreshResult> {
  const timeout = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  const signal =
    args.signal === null ? timeout : AbortSignal.any([args.signal, timeout]);
  return refreshAuthTokenOnceViaHttp(
    args.authnBaseUrl,
    args.token,
    args.refreshToken,
    args.clientKind,
    signal,
  );
}

async function refreshAuthTokenOnceViaHttp(
  authnBaseUrl: string,
  token: string,
  refreshToken: string,
  clientKind: "cli" | "desktop" | null,
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
      body: JSON.stringify({
        refreshToken,
        ...(clientKind === null ? {} : { clientKind }),
      }),
      signal,
    });
  } catch {
    return { kind: "network-error" };
  }

  // A 409 means the authn refresh grace window is mid-rotation: a concurrent refresher won the race and is minting the new pair.
  // This is transient and retriable, not a dead credential, so map it to `network-error` (a retry re-drives and lands on the winner's replayed pair) rather than `rejected`, which would sign the gui out.
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

export type RotatedTokensOutcome =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "transient" };

  /**
   * Parses the rotated `{ token, refreshToken }` pair from a 2xx token-mint response body.
   * Exported so the device-flow client (`device-auth.ts`) can reuse the exact same 200-body shape that `exchange-code` / `refresh` use, without duplicating the field validation.
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
