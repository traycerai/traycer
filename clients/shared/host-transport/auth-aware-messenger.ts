import type { AuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";

/**
 * Optional retry policy for the auth-aware wrapper.
 *
 * The CLI and renderer use this when a caller must complete the refresh loop
 * inside the transport layer: after a revalidation that actually rotated the
 * bearer, the wrapper retries the request once on the rotated value.
 *
 * Retry is gated on the bearer *changing* (compared before/after revalidation)
 * so a rejected/network-failed refresh - which leaves the bearer untouched -
 * does not waste a retry that would deterministically fail the same way.
 */
export interface AuthAwareRetryPolicy {
  readonly bearer: () => OpenFrameBearerSource | null;
}

/**
 * Wraps an `IHostMessenger` so a `HostRpcError` with `code ===
 * "UNAUTHORIZED"` triggers `auth.revalidateCurrentContext()` before the error
 * propagates. The host never refreshes tokens itself - it only signals
 * `UNAUTHORIZED` - so this wrapper is the single client-side place that closes
 * the refresh loop for unary RPC, shared by the renderer and the CLI.
 *
 * With a `retry` policy, a revalidation that rotated the bearer is followed by
 * one more `request` attempt; otherwise (and always, on a second failure) the
 * original error propagates.
 */
/**
 * Reads the current bearer string for the retry gate, tolerating every "no
 * bearer" shape (no retry policy, no source, or a released/empty lease whose
 * `getBearerToken()` throws) by returning `null`. The gate then compares
 * before/after: equal-or-null means "no rotation happened", so don't retry.
 */
function readBearer(retry: AuthAwareRetryPolicy | null): string | null {
  if (retry === null) {
    return null;
  }
  const source = retry.bearer();
  if (source === null) {
    return null;
  }
  try {
    return source.getBearerToken();
  } catch {
    return null;
  }
}

export function createAuthAwareMessenger<Registry extends VersionedRpcRegistry>(
  inner: IHostMessenger<Registry>,
  auth: AuthRevalidator,
  options: { readonly retry: AuthAwareRetryPolicy } | null,
): IHostMessenger<Registry> {
  const runWithAuthRecovery = async <Response>(
    call: () => Promise<Response>,
  ): Promise<Response> => {
    try {
      return await call();
    } catch (cause) {
      if (!(cause instanceof HostRpcError) || cause.code !== "UNAUTHORIZED") {
        throw cause;
      }
      // A transient, host-side rejection (e.g. a JWKS fetch timeout) rides in
      // as `code: "UNAUTHORIZED"` with `fatalDetails.retryable === true`. Our
      // bearer is fine, so revalidating it can't help - rethrow the transient
      // failure and let the caller retry the request instead of churning authn.
      if (cause.fatalDetails?.retryable === true) {
        throw cause;
      }
      const retry = options?.retry ?? null;
      const before = readBearer(retry);
      try {
        await auth.revalidateCurrentContext();
      } catch {
        // Revalidation itself failed (e.g. a renderer provider torn down
        // mid-flight). Surface the ORIGINAL UNAUTHORIZED, not the revalidation
        // error: callers key recovery (session-expired cascade, error toasts)
        // on `code === "UNAUTHORIZED"`, which a generic error would defeat.
        throw cause;
      }
      if (retry === null) {
        throw cause;
      }
      const after = readBearer(retry);
      if (after === null || after === before) {
        throw cause;
      }
      return call();
    }
  };

  return {
    request<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithAuthRecovery(() => inner.request(method, params));
    },
    requestWithResponseTimeout<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      responseTimeoutMs: number,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithAuthRecovery(() =>
        inner.requestWithResponseTimeout(method, params, responseTimeoutMs),
      );
    },
  };
}
