import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  RetryableTransportError,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import { jitteredBackoffFor } from "./backoff";

/**
 * Bounded retry schedule for the unary transport. `maxRetries` is the number of
 * *extra* attempts after the first, so the total attempt budget is
 * `maxRetries + 1`. `sleep` and `random` are injected so tests drive the delay
 * deterministically; production uses {@link DEFAULT_TRANSPORT_RETRY_POLICY}.
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

/**
 * Fail-fast policy (`maxRetries: 0` → a single attempt, no backoff) for paths
 * where time-to-failure matters more than absorbing a transient blip: a host
 * that is reachable but not completing the handshake makes each attempt cost a
 * full dial timeout, so retrying would stack those timeouts. Use it for
 * best-effort, latency-sensitive calls (IDE hook commands) and for probes that
 * already own a retry budget at a higher layer.
 */
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
 * Wraps an `IHostMessenger` so a `RetryableTransportError` - a transient
 * transport failure that the transport proved happened *before* the request
 * frame was sent (dial timeout, handshake drop, `openAck` timeout) - is
 * retried on a fresh dial with jittered exponential backoff, up to
 * `policy.maxRetries` times.
 *
 * Only `RetryableTransportError` is retried: a post-send drop, a malformed
 * frame, an `UNAUTHORIZED`, or any other host-originated `HostRpcError` is a
 * plain `HostRpcError` and propagates on the first attempt. The "pre-send"
 * guarantee is what makes the retry safe even for non-idempotent methods - the
 * host never observed the original call.
 *
 * Compose this *outside* `createAuthAwareMessenger`: the auth wrapper only acts
 * on `UNAUTHORIZED` (never a `RetryableTransportError`), so the two layers
 * never contend, and an auth-driven retry still sits under one transport-retry
 * budget.
 */
export function createRetryingMessenger<Registry extends VersionedRpcRegistry>(
  inner: IHostMessenger<Registry>,
  policy: TransportRetryPolicy,
): IHostMessenger<Registry> {
  const runWithRetries = async <Response>(
    attemptCall: () => Promise<Response>,
  ): Promise<Response> => {
    for (let attempt = 0; attempt < policy.maxRetries; attempt += 1) {
      try {
        return await attemptCall();
      } catch (cause) {
        if (!(cause instanceof RetryableTransportError)) {
          throw cause;
        }
        await policy.sleep(
          jitteredBackoffFor(
            attempt,
            policy.initialDelayMs,
            policy.maxDelayMs,
            policy.random,
          ),
        );
      }
    }
    // Final attempt: out of the retry budget, so let whatever it throws -
    // retryable or not - propagate to the caller unchanged.
    return attemptCall();
  };

  return {
    request<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithRetries(() => inner.request(method, params));
    },
    requestWithResponseTimeout<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      responseTimeoutMs: number,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      return runWithRetries(() =>
        inner.requestWithResponseTimeout(method, params, responseTimeoutMs),
      );
    },
  };
}
