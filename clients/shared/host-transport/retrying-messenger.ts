import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostRequestAbortedError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import { jitteredBackoffFor } from "./backoff";

/**
 * Bounded retry schedule for the unary transport.
 * `maxRetries` is the number of *extra* attempts after the first, so the total attempt budget is `maxRetries + 1`.
 */
export interface TransportRetryPolicy {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export const DEFAULT_TRANSPORT_RETRY_POLICY: TransportRetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  random: () => Math.random(),
};

export const NO_RETRY_TRANSPORT_POLICY: TransportRetryPolicy = {
  maxRetries: 0,
  initialDelayMs: 0,
  maxDelayMs: 0,
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  random: () => Math.random(),
};

/**
 * Wraps an `IHostMessenger` so a `RetryableTransportError` is retried on a fresh dial with jittered exponential backoff, up to `policy.maxRetries` times.
 * A no-dispatch guarantee or a negotiated replay key is what makes the retry safe for non-idempotent methods; an ambiguous unkeyed failure never receives this class.
 */
export function createRetryingMessenger<Registry extends VersionedRpcRegistry>(
  inner: IHostMessenger<Registry>,
  policy: TransportRetryPolicy,
): IHostMessenger<Registry> {
  const runWithRetries = async <Response>(
    authority: HostRequestAuthority,
    method: string,
    attemptCall: (replayMustBeKeyed: boolean) => Promise<Response>,
  ): Promise<Response> => {
    // Carried across attempts, and it only ever latches on.
    let replayMustBeKeyed = false;
    for (let attempt = 0; attempt < policy.maxRetries; attempt += 1) {
      throwIfAuthorityAborted(authority, method);
      try {
        return await attemptCall(replayMustBeKeyed);
      } catch (cause) {
        if (!(cause instanceof RetryableTransportError)) {
          throw cause;
        }
        replayMustBeKeyed = replayMustBeKeyed || cause.replaySafetyFromKey;
        await waitForRetryDelay(
          authority,
          method,
          policy.sleep(
            jitteredBackoffFor(
              attempt,
              policy.initialDelayMs,
              policy.maxDelayMs,
              policy.random,
            ),
          ),
        );
      }
    }
    // Final attempt: out of the retry budget, so let whatever it throws - retryable or not - propagate to the caller unchanged.
    throwIfAuthorityAborted(authority, method);
    return attemptCall(replayMustBeKeyed);
  };

  return {
    request<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithRetries(options.authority, method, (replayMustBeKeyed) =>
        inner.request(method, params, { ...options, replayMustBeKeyed }),
      );
    },
    requestWithResponseTimeout<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      responseTimeoutMs: number,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithRetries(options.authority, method, (replayMustBeKeyed) =>
        inner.requestWithResponseTimeout(method, params, responseTimeoutMs, {
          ...options,
          replayMustBeKeyed,
        }),
      );
    },
  };
}

function throwIfAuthorityAborted(
  authority: HostRequestAuthority,
  method: string,
): void {
  if (!authority.abortSignal.aborted) {
    return;
  }
  throw new HostRequestAbortedError({
    message: "Host request authority was aborted before transport dispatch",
    requestId: "authority-aborted",
    method,
  });
}

function waitForRetryDelay(
  authority: HostRequestAuthority,
  method: string,
  delay: Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      authority.abortSignal.removeEventListener("abort", onAbort);
      reject(
        new HostRequestAbortedError({
          message:
            "Host request authority was aborted during transport retry backoff",
          requestId: "authority-aborted",
          method,
        }),
      );
    };
    authority.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (authority.abortSignal.aborted) {
      onAbort();
      return;
    }
    void delay.then(
      () => {
        authority.abortSignal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        authority.abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
