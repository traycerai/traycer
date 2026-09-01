import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  type HostRequestAuthority,
  type HostRequestOptions,
  RetryableTransportError,
  type IHostMessenger,
} from "../host-messenger";
import {
  createRetryingMessenger,
  NO_RETRY_TRANSPORT_POLICY,
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
function fakeInner(outcomes: ReadonlyArray<HostRpcError>): {
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
      },
    );

    expect(replayRequirements()).toEqual([false, false, false]);
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
      },
    );

    expect(delays).toEqual([
      jitteredBackoffFor(0, 100, 1_000, random),
      jitteredBackoffFor(1, 100, 1_000, random),
    ]);
  });
});
