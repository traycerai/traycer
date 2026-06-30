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
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, "api/v3/user"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
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
  } catch {
    return { kind: "failed", result: { kind: "rejected" } };
  }
  return { kind: "ok", body };
}

/**
 * Single-shot token refresh against the authn service's `/api/v3/auth/refresh`
 * endpoint. Post raw-JWS cutover the access token (`token`, the bearer) and the
 * `refreshToken` are separate: the bearer goes in the `Authorization` header and
 * the `refreshToken` in the request body (the endpoint requires it). A success
 * rotates BOTH, so we return the new `{ token, refreshToken }` for the caller to
 * persist. Exported so the CLI's host-auth boundary can refresh a stale bearer
 * on a host `401` without re-running a full `/api/v3/user` validation round
 * trip.
 */
export async function refreshAuthTokenViaHttp(
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
  if (rotated === null) {
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
 * any other non-2xx or a transport failure is a transient `network-error`.
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
  if (tokens === null) {
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
 * Parses the rotated `{ token, refreshToken }` pair from a 2xx token-mint
 * response body. Exported so the device-flow client (`device-auth.ts`) can
 * reuse the exact same 200-body shape that `exchange-code` / `refresh` use,
 * without duplicating the field validation. Returns `null` when the body is
 * missing either non-empty string field.
 */
export async function readRotatedTokens(
  response: Response,
): Promise<{ readonly token: string; readonly refreshToken: string } | null> {
  try {
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") {
      return null;
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
      return null;
    }

    return { token, refreshToken };
  } catch {
    return null;
  }
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
