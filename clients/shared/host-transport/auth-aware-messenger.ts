import type {
  AuthorityBoundAuthRevalidator,
  RevalidateOutcome,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  HostAuthoritySupersededError,
  HostRequestAbortedError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";

/** Wraps an `IHostMessenger` so `unauthorized` triggers `auth.revalidateCurrentContext()`; the host never refreshes tokens itself. */
/** Current bearer for the retry gate; every "no bearer" shape is `null`. Equal-or-null means no rotation, so do not retry. */
function readBearer(source: OpenFrameBearerSource): string | null {
  try {
    return source.getBearerToken();
  } catch {
    return null;
  }
}

export function createAuthAwareMessenger<Registry extends VersionedRpcRegistry>(
  inner: IHostMessenger<Registry>,
  auth: AuthorityBoundAuthRevalidator,
): IHostMessenger<Registry> {
  const runWithAuthRecovery = async <Response>(
    authority: HostRequestAuthority,
    method: string,
    call: () => Promise<Response>,
  ): Promise<Response> => {
    try {
      return await call();
    } catch (cause) {
      if (!(cause instanceof HostRpcError) || cause.code !== "UNAUTHORIZED") {
        throw cause;
      }
      // A transient, host-side rejection (e.g. a jwks fetch timeout) rides in as `code: "unauthorized"` with `fatalDetails.retryable === true`.
      // Our bearer is fine, so revalidating it can't help - rethrow the transient failure and let the caller retry the request instead of churning authn.
      if (cause.fatalDetails?.retryable === true) {
        throw cause;
      }
      if (authority.abortSignal.aborted) {
        throw new HostRequestAbortedError({
          message:
            "Host request authority was aborted before authentication recovery",
          requestId: "authority-aborted",
          method,
        });
      }
      const before = readBearer(authority.bearer);
      let outcome: RevalidateOutcome | "superseded";
      try {
        outcome = await auth.revalidateExpectedBearer(authority.bearer);
      } catch {
        throw cause;
      }
      if (outcome === "superseded") {
        throw new HostAuthoritySupersededError();
      }
      if (outcome !== "rotated" || authority.abortSignal.aborted) {
        if (authority.abortSignal.aborted) {
          throw new HostRequestAbortedError({
            message:
              "Host request authority was aborted during authentication recovery",
            requestId: "authority-aborted",
            method,
          });
        }
        throw cause;
      }
      const after = readBearer(authority.bearer);
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
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithAuthRecovery(options.authority, method, () =>
        inner.request(method, params, options),
      );
    },
    requestWithResponseTimeout<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      responseTimeoutMs: number,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithAuthRecovery(options.authority, method, () =>
        inner.requestWithResponseTimeout(
          method,
          params,
          responseTimeoutMs,
          options,
        ),
      );
    },
  };
}
