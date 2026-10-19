import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  HostAuthoritySupersededError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
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
 * Wraps an `IHostMessenger` so a `RetryableTransportError` is retried on a
 * fresh dial with jittered exponential backoff, up to `policy.maxRetries`
 * times. That classification covers either a provably pre-dispatch failure or
 * a post-send failure carrying a key the host negotiated and deduplicates.
 *
 * Only `RetryableTransportError` is retried: an ambiguous post-send drop, a
 * malformed frame, an `UNAUTHORIZED`, or any other host-originated
 * `HostRpcError` propagates on the first attempt. A no-dispatch guarantee or a
 * negotiated replay key is what makes the retry safe for non-idempotent
 * methods; an ambiguous unkeyed failure never receives this class.
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
    authority: HostRequestAuthority,
    method: string,
    attemptCall: (replayMustBeKeyed: boolean) => Promise<Response>,
  ): Promise<Response> => {
    // Carried across attempts, and it only ever LATCHES on. Once any attempt
    // has failed on ground that only a negotiated key made safe, every later
    // attempt in this episode is a replay of a call that may already have
    // committed - including one whose own immediate predecessor happened to
    // fail pre-dispatch. Recomputing it per attempt would forget that.
    let replayMustBeKeyed = false;
    for (let attempt = 0; attempt < policy.maxRetries; attempt += 1) {
      throwIfAuthorityAborted(authority, method, replayMustBeKeyed);
      try {
        return await attemptCall(replayMustBeKeyed);
      } catch (cause) {
        if (!(cause instanceof RetryableTransportError)) {
          throw withEpisodeDispatch(cause, method, replayMustBeKeyed);
        }
        replayMustBeKeyed = replayMustBeKeyed || cause.replaySafetyFromKey;
        await waitForRetryDelay(
          authority,
          method,
          replayMustBeKeyed,
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
    // Final attempt: out of the retry budget, so whatever it throws -
    // retryable or not - propagates to the caller, with the episode's earlier
    // send restored (`withEarlierAttemptDispatch`). Still carries the requirement: being the last
    // attempt does not make an unkeyed replay any safer.
    throwIfAuthorityAborted(authority, method, replayMustBeKeyed);
    try {
      return await attemptCall(replayMustBeKeyed);
    } catch (cause) {
      throw withEarlierAttemptDispatch(cause, method, replayMustBeKeyed);
    }
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

/**
 * The ending of a retry episode whose earlier attempt was sent and its answer
 * lost, when a LATER attempt was refused: the outcome is unknown, because the
 * refusal speaks for the later attempt only and the host may have run the
 * earlier one. A refusal that never reached the host proves this most
 * plainly - a reconnect to an incarnation below the method floor the call
 * requires (`HostMethodVersionUnsatisfiedError`), or an `UNAUTHORIZED` the
 * auth layer could not recover - but no refusal of a later attempt recalls
 * an earlier one.
 *
 * An unattested `HostTransportFailureError`, so every reader of an ambiguous
 * post-send drop reads it as one (the create flow polls for the epic; an owner
 * write says no reply came back). The refusal is kept as `finalRefusal`, for a
 * caller that has guidance to give once the outcome is settled.
 */
export class RetryEpisodeOutcomeUnknownError extends HostTransportFailureError {
  readonly finalRefusal: HostRpcError;

  constructor(finalRefusal: HostRpcError) {
    super({
      code: "RPC_ERROR",
      message: `An earlier attempt may have reached the host before a later one was refused: ${finalRefusal.message}`,
      requestId: finalRefusal.requestId,
      method: finalRefusal.method,
      fatalDetails: null,
    });
    this.name = "RetryEpisodeOutcomeUnknownError";
    this.finalRefusal = finalRefusal;
  }
}

/**
 * The failure that ends a call, when an earlier attempt of it may have reached
 * the host and this one is the last. A PRE-send failure must not erase the
 * earlier send: handed on as it is, it reads as "the host never saw it", and a
 * retrying layer above would replay the call unkeyed. It keeps its class with
 * the sent-and-dropped ground restored, so that layer's next attempt has to be
 * keyed. Every other failure goes through {@link withEpisodeDispatch}.
 *
 * Shared by this messenger's final attempt and the auth-aware messenger's
 * retry after credential recovery.
 */
export function withEarlierAttemptDispatch(
  cause: unknown,
  method: string,
  sentEarlier: boolean,
): unknown {
  if (
    sentEarlier &&
    cause instanceof RetryableTransportError &&
    !cause.replaySafetyFromKey
  ) {
    return new RetryableTransportError({
      code: cause.code,
      message: cause.message,
      requestId: cause.requestId,
      method: cause.method,
      fatalDetails: cause.fatalDetails,
      replaySafetyFromKey: true,
    });
  }
  return withEpisodeDispatch(cause, method, sentEarlier);
}

/**
 * A later attempt's failure, after an earlier one was sent and its answer
 * lost, carries the episode's possible dispatch: the host may be running the
 * earlier send whatever this attempt did. An abort says so on its own flag; a
 * refusal becomes {@link RetryEpisodeOutcomeUnknownError}. An unattested
 * transport drop already reads as unknown and is passed on as it is.
 *
 * The auth layer's `HostAuthoritySupersededError` - the session was replaced
 * while a later attempt's `UNAUTHORIZED` was being recovered - is no
 * `HostRpcError`, and normalized at the app's boundary it would read as a
 * definite failure. It becomes an unattested transport failure instead, so
 * it reads as the unknown outcome it is. Nothing reads the superseded class
 * itself; with no earlier send it is passed on as it is.
 */
export function withEpisodeDispatch(
  cause: unknown,
  method: string,
  sentEarlier: boolean,
): unknown {
  if (!sentEarlier) return cause;
  if (cause instanceof HostAuthoritySupersededError) {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: `An earlier attempt may have reached the host before authentication recovery was superseded: ${cause.message}`,
      requestId: "authority-superseded",
      method,
      fatalDetails: null,
    });
  }
  if (!(cause instanceof HostRpcError)) return cause;
  // States its own ground; the final attempt restores the keyed one.
  if (cause instanceof RetryableTransportError) return cause;
  if (cause instanceof HostRequestAbortedError) {
    return cause.mayHaveDispatched
      ? cause
      : new HostRequestAbortedError({
          message: cause.message,
          requestId: cause.requestId,
          method: cause.method,
          mayHaveDispatched: true,
        });
  }
  if (
    cause instanceof HostTransportFailureError &&
    cause.fatalDetails === null
  ) {
    return cause;
  }
  return new RetryEpisodeOutcomeUnknownError(cause);
}

/**
 * `sentEarlier` is the episode's latch: an earlier attempt was sent and its
 * answer lost, so an abort now still leaves a request the host may be running.
 */
function throwIfAuthorityAborted(
  authority: HostRequestAuthority,
  method: string,
  sentEarlier: boolean,
): void {
  if (!authority.abortSignal.aborted) {
    return;
  }
  throw new HostRequestAbortedError({
    message: "Host request authority was aborted before transport dispatch",
    requestId: "authority-aborted",
    method,
    mayHaveDispatched: sentEarlier,
  });
}

function waitForRetryDelay(
  authority: HostRequestAuthority,
  method: string,
  sentEarlier: boolean,
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
          mayHaveDispatched: sentEarlier,
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
