import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  HostAuthoritySupersededError,
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  type HostRequestAuthority,
  type HostRequestOptions,
  RetryableTransportError,
  type IHostMessenger,
} from "../host-messenger";
import {
  createRetryingMessenger,
  NO_RETRY_TRANSPORT_POLICY,
  RetryEpisodeOutcomeUnknownError,
  type TransportRetryPolicy,
} from "../retrying-messenger";
import { jitteredBackoffFor } from "../backoff";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const testRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: echoV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

function retryableError(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "WebSocket dial timed out after 10000ms",
    requestId: "req",
    method: "host.echo",
    fatalDetails: null,
  });
}

/**
 * The other ground for the same class: a POST-SEND failure that is retryable
 * only because the connection negotiated the idempotency key. Distinct from
 * `retryableError`'s pre-dispatch ground in exactly the field the wrapper
 * latches on.
 */
function keyEarnedRetryableError(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: true,
    code: "RPC_ERROR",
    message: "connection dropped after dispatch",
    requestId: "req",
    method: "host.echo",
    fatalDetails: null,
  });
}

function fatalError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "host rejected",
    requestId: "req",
    method: "host.echo",
    fatalDetails: null,
  });
}

/**
 * Inner messenger that throws the queued outcomes (in order) then resolves with
 * `{ echoed }`. Records how many times `request` was called.
 */
function fakeInner(
  outcomes: ReadonlyArray<HostRpcError | HostAuthoritySupersededError>,
): {
  readonly messenger: IHostMessenger<typeof testRegistry>;
  calls: () => number;
  /** `options.replayMustBeKeyed` as each attempt actually received it. */
  replayRequirements: () => ReadonlyArray<boolean>;
} {
  let call = 0;
  const replayRequirements: boolean[] = [];
  // Written as a `vi.fn()` rather than a hand-rolled `request<Method>(…)`
  // method: the interface promises `ResponseOfMethod<Registry, Method>` for an
  // unresolved `Method`, which a concrete `{ echoed }` literal cannot satisfy
  // (the real wrapper only type-checks because it *delegates*, preserving the
  // type parameter). The mock stays loosely typed and assignable.
  const request = vi
    .fn()
    .mockImplementation(
      (
        method: string,
        params: { message: string },
        options: HostRequestOptions,
      ) => {
        const index = call;
        call += 1;
        replayRequirements.push(options.replayMustBeKeyed);
        const outcome = outcomes[index];
        if (outcome !== undefined) {
          return Promise.reject(outcome);
        }
        void method;
        return Promise.resolve({ echoed: params.message.toUpperCase() });
      },
    );
  const messenger: IHostMessenger<typeof testRegistry> = {
    request,
    // The retry wrapper drives both paths through the same `runWithRetries`,
    // so the long-poll variant shares this mock (and its call counter).
    requestWithResponseTimeout: request,
  };
  return {
    messenger,
    calls: () => call,
    replayRequirements: () => replayRequirements,
  };
}

function makeRecordingPolicy(
  maxRetries: number,
  initialDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): {
  readonly policy: TransportRetryPolicy;
  readonly delays: number[];
} {
  const delays: number[] = [];
  const policy: TransportRetryPolicy = {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    random,
  };
  return { policy, delays };
}

function authority(): HostRequestAuthority {
  return {
    endpoint: { hostId: "test-host", websocketUrl: "ws://test-host/rpc" },
    bearer: {
      identity: { userId: "u1" },
      getBearerToken: () => "token",
    },
    abortSignal: new AbortController().signal,
  };
}

describe("createRetryingMessenger", () => {
  it("returns the first success without sleeping", async () => {
    const { messenger, calls } = fakeInner([]);
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const result = await createRetryingMessenger(messenger, policy).request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: null,
        authority: authority(),
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      },
    );

    expect(result).toEqual({ echoed: "HI" });
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries a RetryableTransportError and resolves on the next attempt", async () => {
    const { messenger, calls } = fakeInner([retryableError()]);
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const result = await createRetryingMessenger(messenger, policy).request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: null,
        authority: authority(),
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      },
    );

    expect(result).toEqual({ echoed: "HI" });
    expect(calls()).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it("gives up after the retry budget and rejects with the last error", async () => {
    // maxRetries=2 → 3 total attempts, all retryable.
    const { messenger, calls } = fakeInner([
      retryableError(),
      retryableError(),
      retryableError(),
    ]);
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    await expect(
      createRetryingMessenger(messenger, policy).request(
        "host.echo",
        {
          message: "hi",
        },
        {
          idempotencyKey: null,
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      ),
    ).rejects.toBeInstanceOf(RetryableTransportError);
    expect(calls()).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("does NOT retry a plain HostRpcError", async () => {
    const { messenger, calls } = fakeInner([fatalError()]);
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    await expect(
      createRetryingMessenger(messenger, policy).request(
        "host.echo",
        {
          message: "hi",
        },
        {
          idempotencyKey: null,
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        !(error instanceof RetryableTransportError),
    );
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("NO_RETRY_TRANSPORT_POLICY makes exactly one attempt on a retryable error", async () => {
    const { messenger, calls } = fakeInner([retryableError()]);

    await expect(
      createRetryingMessenger(messenger, NO_RETRY_TRANSPORT_POLICY).request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: null,
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      ),
    ).rejects.toBeInstanceOf(RetryableTransportError);
    expect(calls()).toBe(1);
  });

  it("latches the replay-must-be-keyed requirement once a key earns a retry, and a later pre-dispatch failure does not clear it", async () => {
    // Three attempts, and the MIDDLE one is the discriminator. Attempt 2's
    // failure is pre-dispatch (`replaySafetyFromKey: false`), so a wrapper that
    // recomputed the requirement per attempt - rather than latching it - would
    // hand attempt 3 a `false` and license exactly the unkeyed replay of a call
    // that attempt 1 may already have committed. Two attempts could not tell
    // the two implementations apart: both would report `[false, true]`.
    const { messenger, calls, replayRequirements } = fakeInner([
      keyEarnedRetryableError(),
      retryableError(),
    ]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const result = await createRetryingMessenger(messenger, policy).request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: "k-1",
        authority: authority(),
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      },
    );

    expect(result).toEqual({ echoed: "HI" });
    expect(calls()).toBe(3);
    expect(replayRequirements()).toEqual([false, true, true]);
  });

  it("leaves the requirement off when every failure is pre-dispatch", async () => {
    // The negative half of the pin above: `true` must be EARNED. Without this,
    // an implementation that latched on any `RetryableTransportError` at all
    // would pass the test above and quietly refuse legitimate first-send
    // downgrades against hosts that predate the capability.
    const { messenger, replayRequirements } = fakeInner([
      retryableError(),
      retryableError(),
    ]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    await createRetryingMessenger(messenger, policy).request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: "k-1",
        authority: authority(),
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      },
    );

    expect(replayRequirements()).toEqual([false, false, false]);
  });

  it("marks the final pre-send error as replay-unsafe once an earlier attempt was sent and dropped", async () => {
    // Attempt 1 was sent and its answer lost, so the host may have run it. The
    // budget then runs out on pre-send failures. What the caller receives has
    // to keep saying "this may have been applied": a bare pre-send error would
    // read as "the host never saw it".
    const { messenger } = fakeInner([
      keyEarnedRetryableError(),
      retryableError(),
      retryableError(),
    ]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(RetryableTransportError);
    expect((failure as RetryableTransportError).replaySafetyFromKey).toBe(true);
    expect((failure as RetryableTransportError).message).toBe(
      "WebSocket dial timed out after 10000ms",
    );
  });

  it("an abort in the backoff after a sent-and-dropped attempt says the request may have reached the host", async () => {
    // Attempt 1 was sent and its answer lost. Cancelling while waiting to
    // retry stops the caller from waiting; it does not recall attempt 1.
    const controller = new AbortController();
    const { messenger } = fakeInner([keyEarnedRetryableError()]);
    const policy: TransportRetryPolicy = {
      maxRetries: 2,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      sleep: () => {
        controller.abort();
        return new Promise<void>(() => undefined);
      },
      random: () => 0.5,
    };

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: { ...authority(), abortSignal: controller.signal },
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HostRequestAbortedError);
    expect(
      failure instanceof HostRequestAbortedError && failure.mayHaveDispatched,
    ).toBe(true);
  });

  it("an abort in the backoff after only pre-send failures says the request never left", async () => {
    const controller = new AbortController();
    const { messenger } = fakeInner([retryableError()]);
    const policy: TransportRetryPolicy = {
      maxRetries: 2,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      sleep: () => {
        controller.abort();
        return new Promise<void>(() => undefined);
      },
      random: () => 0.5,
    };

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: { ...authority(), abortSignal: controller.signal },
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HostRequestAbortedError);
    expect(
      failure instanceof HostRequestAbortedError && failure.mayHaveDispatched,
    ).toBe(false);
  });

  it("a later attempt's pre-send abort keeps the episode's earlier send", async () => {
    const { messenger } = fakeInner([
      keyEarnedRetryableError(),
      new HostRequestAbortedError({
        message: "aborted before dispatch",
        requestId: "req",
        method: "host.echo",
        mayHaveDispatched: false,
      }),
    ]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(
      failure instanceof HostRequestAbortedError && failure.mayHaveDispatched,
    ).toBe(true);
  });

  // traycerai/traycer thread TEUc: a later refusal speaks for the later
  // attempt only. A reconnect to a host below the call's method floor is
  // refused before dispatch, after the earlier keyed send may have committed.
  it("a refusal of a later attempt, after a sent-and-dropped one, keeps the outcome unknown", async () => {
    const floorRefusal = new HostMethodVersionUnsatisfiedError({
      requirement: {
        method: "host.echo",
        version: { major: 1, minor: 2 },
      },
      negotiated: { major: 1, minor: 0 },
      requestId: "req-2",
      method: "host.echo",
      hostId: "test-host",
    });
    const { messenger } = fakeInner([keyEarnedRetryableError(), floorRefusal]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(RetryEpisodeOutcomeUnknownError);
    expect(failure).toBeInstanceOf(HostTransportFailureError);
    expect(failure).not.toBeInstanceOf(RetryableTransportError);
    if (!(failure instanceof RetryEpisodeOutcomeUnknownError)) return;
    expect(failure.fatalDetails).toBeNull();
    expect(failure.finalRefusal).toBe(floorRefusal);
  });

  // traycerai/traycer thread taE6-: a replay refused UNAUTHORIZED whose
  // session is replaced during auth recovery ends in the auth layer's
  // superseded error, which is no `HostRpcError`. After a sent-and-dropped
  // attempt it must still read as an unknown outcome, or the create flow
  // reports a definite failure for a create that may have committed.
  it("a superseded auth recovery after a sent-and-dropped attempt keeps the outcome unknown", async () => {
    const { messenger } = fakeInner([
      keyEarnedRetryableError(),
      new HostAuthoritySupersededError(),
    ]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HostTransportFailureError);
    expect(failure).not.toBeInstanceOf(RetryableTransportError);
    if (!(failure instanceof HostTransportFailureError)) return;
    expect(failure.fatalDetails).toBeNull();
    expect(failure.method).toBe("host.echo");
  });

  it("a superseded auth recovery with no earlier send is passed on as it is", async () => {
    const superseded = new HostAuthoritySupersededError();
    const { messenger } = fakeInner([retryableError(), superseded]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    await expect(
      createRetryingMessenger(messenger, policy).request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      ),
    ).rejects.toBe(superseded);
  });

  it("a refusal with no earlier send is the refusal itself", async () => {
    const refusal = new HostRpcError({
      code: "FORBIDDEN",
      message: "no",
      requestId: "req-1",
      method: "host.echo",
      fatalDetails: null,
    });
    const { messenger } = fakeInner([retryableError(), refusal]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    await expect(
      createRetryingMessenger(messenger, policy).request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      ),
    ).rejects.toBe(refusal);
  });

  it("leaves the final error pre-send when no attempt was ever sent", async () => {
    const { messenger } = fakeInner([
      retryableError(),
      retryableError(),
      retryableError(),
    ]);
    const { policy } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const failure = await createRetryingMessenger(messenger, policy)
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: "k-1",
          authority: authority(),
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect((failure as RetryableTransportError).replaySafetyFromKey).toBe(
      false,
    );
  });

  it("backs off on the shared jittered schedule", async () => {
    const { messenger } = fakeInner([retryableError(), retryableError()]);
    const random = () => 0.5;
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, random);

    await createRetryingMessenger(messenger, policy).request(
      "host.echo",
      {
        message: "hi",
      },
      {
        idempotencyKey: null,
        authority: authority(),
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      },
    );

    expect(delays).toEqual([
      jitteredBackoffFor(0, 100, 1_000, random),
      jitteredBackoffFor(1, 100, 1_000, random),
    ]);
  });
});
