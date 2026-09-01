/**
 * Device push-token registration against authn-v3 (`/api/v3/user/push-tokens`).
 *
 * The registration binds a provider push token (APNs/FCM) to the CALLER'S OWN
 * session family - authn rejects a caller whose credential carries no session
 * family, and revoking that session cascades the token row away server-side.
 * Removal is `POST ./remove` rather than a DELETE because the token is a
 * deliverable address that has no business in a URL.
 *
 * Both calls are best-effort from every caller's point of view: a shell that
 * cannot register simply gets no pushes (the in-app feed and its 30s poll are
 * unaffected), and a shell that cannot unregister at sign-out leans on the
 * server-side session-revocation cascade that removes the row anyway. That is
 * why the results collapse to coarse variants instead of surfacing bodies.
 */

const PUSH_TOKEN_FETCH_TIMEOUT_MS = 10_000;

export type DevicePushPlatform = "ios" | "android";

/**
 * APNs sandbox/production axis. Android has no such split - authn rejects
 * `android` + `sandbox`, so Android callers always send `"production"`.
 */
export type DevicePushEnvironment = "sandbox" | "production";

export interface RegisterDevicePushTokenInput {
  readonly token: string;
  readonly platform: DevicePushPlatform;
  readonly environment: DevicePushEnvironment;
}

export type PushTokenFetchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  /** authn refused the request shape (e.g. android+sandbox) - a caller bug,
   * not a transient; retrying the identical request cannot succeed. */
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

/** Named function types so callers can inject fakes without `typeof` chains. */
export type RegisterDevicePushTokenFn = (
  authnBaseUrl: string,
  bearerToken: string,
  input: RegisterDevicePushTokenInput,
) => Promise<PushTokenFetchResult>;

export type RemoveDevicePushTokenFn = (
  authnBaseUrl: string,
  bearerToken: string,
  token: string,
) => Promise<PushTokenFetchResult>;

function authnApiUrl(authnBaseUrl: string, path: string): string {
  return new URL(
    path.replace(/^\/+/, ""),
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

async function postPushTokens(
  authnBaseUrl: string,
  path: string,
  bearerToken: string,
  body: Record<string, string>,
): Promise<PushTokenFetchResult> {
  let response: Response;
  try {
    response = await fetch(authnApiUrl(authnBaseUrl, path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUSH_TOKEN_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "network-error" };
  }
  if (response.ok) return { kind: "ok" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status === 400) return { kind: "rejected" };
  return { kind: "network-error" };
}

export const registerDevicePushTokenViaHttp: RegisterDevicePushTokenFn = (
  authnBaseUrl,
  bearerToken,
  input,
) =>
  postPushTokens(authnBaseUrl, "api/v3/user/push-tokens", bearerToken, {
    token: input.token,
    platform: input.platform,
    environment: input.environment,
  });

export const removeDevicePushTokenViaHttp: RemoveDevicePushTokenFn = (
  authnBaseUrl,
  bearerToken,
  token,
) =>
  postPushTokens(authnBaseUrl, "api/v3/user/push-tokens/remove", bearerToken, {
    token,
  });
