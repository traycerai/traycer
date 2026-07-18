import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  HostRpcError,
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
    code: "RPC_ERROR",
    message: "WebSocket dial timed out after 10000ms",
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
} {
  let call = 0;
  // Written as a `vi.fn()` rather than a hand-rolled `request<Method>(…)`
  // method: the interface promises `ResponseOfMethod<Registry, Method>` for an
  // unresolved `Method`, which a concrete `{ echoed }` literal cannot satisfy
  // (the real wrapper only type-checks because it *delegates*, preserving the
  // type parameter). The mock stays loosely typed and assignable.
  const request = vi
    .fn()
    .mockImplementation((method: string, params: { message: string }) => {
      const index = call;
      call += 1;
      const outcome = outcomes[index];
      if (outcome !== undefined) {
        return Promise.reject(outcome);
      }
      void method;
      return Promise.resolve({ echoed: params.message.toUpperCase() });
    });
  const messenger: IHostMessenger<typeof testRegistry> = {
    request,
    // The retry wrapper drives both paths through the same `runWithRetries`,
    // so the long-poll variant shares this mock (and its call counter).
    requestWithResponseTimeout: request,
  };
  return { messenger, calls: () => call };
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

describe("createRetryingMessenger", () => {
  it("returns the first success without sleeping", async () => {
    const { messenger, calls } = fakeInner([]);
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    const result = await createRetryingMessenger(messenger, policy).request(
      "host.echo",
      { message: "hi" },
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
      createRetryingMessenger(messenger, policy).request("host.echo", {
        message: "hi",
      }),
    ).rejects.toBeInstanceOf(RetryableTransportError);
    expect(calls()).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("does NOT retry a plain HostRpcError", async () => {
    const { messenger, calls } = fakeInner([fatalError()]);
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, () => 0.5);

    await expect(
      createRetryingMessenger(messenger, policy).request("host.echo", {
        message: "hi",
      }),
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
      ),
    ).rejects.toBeInstanceOf(RetryableTransportError);
    expect(calls()).toBe(1);
  });

  it("backs off on the shared jittered schedule", async () => {
    const { messenger } = fakeInner([retryableError(), retryableError()]);
    const random = () => 0.5;
    const { policy, delays } = makeRecordingPolicy(2, 100, 1_000, random);

    await createRetryingMessenger(messenger, policy).request("host.echo", {
      message: "hi",
    });

    expect(delays).toEqual([
      jitteredBackoffFor(0, 100, 1_000, random),
      jitteredBackoffFor(1, 100, 1_000, random),
    ]);
  });
});
