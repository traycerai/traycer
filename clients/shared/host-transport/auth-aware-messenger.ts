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
  mayHaveReachedHost,
  type HostRequestAuthority,
  type HostRequestOptions,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import {
  withEarlierAttemptDispatch,
  withEpisodeDispatch,
} from "./retrying-messenger";

/**
 * Reads the current bearer string for the retry gate, tolerating a released
 * or empty lease (whose `getBearerToken()` throws) by returning `null`. The
 * gate then compares before/after: when `after` is null, or `after` equals
 * `before`, no rotation happened, so don't retry.
 */
function readBearer(source: OpenFrameBearerSource): string | null {
  try {
    return source.getBearerToken();
  } catch {
    return null;
  }
}

/**
 * Wraps an `IHostMessenger` so a `HostRpcError` with `code ===
 * "UNAUTHORIZED"` triggers `auth.revalidateExpectedBearer(authority.bearer)`
 * before the error propagates. The host never refreshes tokens itself - it
 * only signals `UNAUTHORIZED` - so this wrapper is the single client-side
 * place that closes the refresh loop for unary RPC, shared by the renderer and
 * the CLI.
 *
 * Recovery is bound to the request's own authority, the bearer object that
 * produced the rejected `open`, not to whatever context is current: by the
 * time the refusal arrives the person may have switched account or signed
 * out, and refreshing or signing out that newer context on an old request's
 * say-so would act on a session the refusal says nothing about. A recovery
 * whose bearer is no longer current comes back `"superseded"`.
 *
 * A revalidation that rotated the bearer is followed by one more `request`
 * attempt, whose failure propagates. One that did not rotate rethrows the
 * original error; an abort during recovery rejects with
 * `HostRequestAbortedError`, and a superseded recovery with
 * `HostAuthoritySupersededError`.
 *
 * Recovery never hides that the first attempt may have reached the host (see
 * `mayHaveReachedHost`; a session that went fatal with the request pending is
 * the case that brings one here). After such an attempt an abort during
 * recovery says it may have dispatched, a superseded recovery is an unattested
 * transport failure, and the retry's failure carries the earlier send the way
 * a retry episode's does. A first attempt that never left ends every exit as
 * the paragraph above says.
 */
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
      // A transient, host-side rejection (e.g. a JWKS fetch timeout) rides in
      // as `code: "UNAUTHORIZED"` with `fatalDetails.retryable === true`. Our
      // bearer is fine, so revalidating it can't help - rethrow the transient
      // failure and let the caller retry the request instead of churning authn.
      if (cause.fatalDetails?.retryable === true) {
        throw cause;
      }
      // Every exit below that rethrows `cause` hands on this same object, so
      // its own mark already says so; the exits that build a new error state
      // it.
      const sentEarlier = mayHaveReachedHost(cause);
      if (authority.abortSignal.aborted) {
        throw new HostRequestAbortedError({
          message:
            "Host request authority was aborted before authentication recovery",
          requestId: "authority-aborted",
          method,
          mayHaveDispatched: sentEarlier,
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
        throw withEpisodeDispatch(
          new HostAuthoritySupersededError(),
          method,
          sentEarlier,
        );
      }
      // Anything but a rotation rethrows, and that is the right answer for
      // `local-plane-retained` too: a unary call has no reconnect ladder to put
      // a retained local plane on, and the bearer in hand is the one the host
      // just refused. The caller sees the original failure and decides.
      if (outcome !== "rotated" || authority.abortSignal.aborted) {
        if (authority.abortSignal.aborted) {
          throw new HostRequestAbortedError({
            message:
              "Host request authority was aborted during authentication recovery",
            requestId: "authority-aborted",
            method,
            mayHaveDispatched: sentEarlier,
          });
        }
        throw cause;
      }
      const after = readBearer(authority.bearer);
      if (after === null || after === before) {
        throw cause;
      }
      try {
        return await call();
      } catch (retryCause) {
        throw withEarlierAttemptDispatch(retryCause, method, sentEarlier);
      }
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
