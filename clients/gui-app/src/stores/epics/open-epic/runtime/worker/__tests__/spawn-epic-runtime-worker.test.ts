import { describe, expect, it, vi } from "vitest";
import type {
  BridgeMessageEventLike,
  BridgeMessageTargetLike,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import {
  isMainToWorkerFrame,
  type MainToWorkerEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { createWorkerBridgeEndpoint } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import { stubRuntimeWorkerCallHandlers } from "@traycer-clients/shared/replica-runtime/worker/test-support/stub-runtime-worker-call-handlers";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { HostCredentialMintFlow } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import type { HostClientChangeEvent } from "@traycer-clients/shared/host-client/host-client";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { BearerPumpHostClient } from "../epic-runtime-bearer-pump";
import {
  startEpicRuntimeWorkerHost,
  type EpicRuntimeWorkerHost,
} from "../epic-runtime-worker-host";
import type { RuntimeProjectionHandlers } from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";
import {
  spawnEpicRuntimeWorker,
  type RuntimeWorkerLike,
  type SpawnEpicRuntimeWorkerOptions,
} from "../spawn-epic-runtime-worker";

/**
 * Projection handlers that accept nothing, for tests that are not about
 * projections. `accept` answering `null` is honest here: these fixtures never
 * emit a projection, so nothing should ever be applied.
 */
const SILENT_PROJECTION: RuntimeProjectionHandlers<never> = {
  accept: () => null,
  apply: () => {},
  reject: () => {},
};

const SILENT_HOST_CLIENT: BearerPumpHostClient = {
  getRequestContext: () => null,
  onChange: () => () => {},
  onBearerRotated: () => () => {},
};

/**
 * One construction site for the spawner's options.
 *
 * `SpawnEpicRuntimeWorkerOptions` MIRRORS what the worker needs from the main
 * thread, so it grows every time a push, a call, or a bootstrap fact is added -
 * and this file had SIX literals before the worker->main direction landed,
 * which would have been six compile errors for one ruling. The same collapse
 * `stubCore` and `stubMainCallHandlers` already do on the other seams.
 *
 * The defaults are inert rather than realistic: no bearer, no address, a
 * revalidate that changes nothing and a mint that hands over nothing. A test
 * that cares about one of them overrides exactly that one, so what it is
 * actually asserting on is visible at its own call site.
 */
function spawnOptions<TProjection>(
  required: Pick<
    SpawnEpicRuntimeWorkerOptions<TProjection>,
    "createWorker" | "projection"
  >,
  overrides: Partial<SpawnEpicRuntimeWorkerOptions<TProjection>>,
): SpawnEpicRuntimeWorkerOptions<TProjection> {
  const base: SpawnEpicRuntimeWorkerOptions<TProjection> = {
    createWorker: required.createWorker,
    projection: required.projection,
    hostClient: SILENT_HOST_CLIENT,
    relay: { log: () => {}, fatal: () => {} },
    hostId: "host-1",
    userId: "user-1",
    auth: { revalidateForReconnect: () => Promise.resolve("network-error") },
    mint: () => Promise.resolve({ kind: "unavailable" }),
    endpoint: () => null,
    subscribeEndpointChange: () => () => {},
    onHostRecovered: () => {},
    windowLabel: "window-1",
  };
  return { ...base, ...overrides };
}

interface SpawnFixture {
  readonly pair: FakeBridgePair;
  readonly worker: RuntimeWorkerLike;
  readonly terminate: () => void;
  readonly host: EpicRuntimeWorkerHost | null;
  readonly rotations: Set<() => void>;
}

/** The `Worker`-shaped adapter over the fake pair's main side. */
function attachWorkerTarget(pair: FakeBridgePair): BridgeMessageTargetLike {
  const workerListeners = new Set<(event: BridgeMessageEventLike) => void>();
  pair.main.subscribe((message) => {
    const event: BridgeMessageEventLike = { data: message };
    for (const listener of [...workerListeners]) listener(event);
  });
  return {
    postMessage(message, transfer): void {
      const buffers = transfer.filter(
        (value): value is ArrayBuffer => value instanceof ArrayBuffer,
      );
      pair.main.post(message, buffers);
    },
    addEventListener(
      _type: "message",
      listener: (event: BridgeMessageEventLike) => void,
    ): void {
      workerListeners.add(listener);
    },
    removeEventListener(
      _type: "message",
      listener: (event: BridgeMessageEventLike) => void,
    ): void {
      workerListeners.delete(listener);
    },
  };
}

function createFixture(withHost: boolean): SpawnFixture {
  const pair = createFakeBridgePair("sync");
  const rotations = new Set<() => void>();
  const terminate = vi.fn();
  const worker: RuntimeWorkerLike = {
    ...attachWorkerTarget(pair),
    terminate,
  };
  const host = withHost ? startEpicRuntimeWorkerHost(pair.worker) : null;
  return { pair, worker, terminate, host, rotations };
}

function createHostClient(fixture: SpawnFixture): {
  readonly hostClient: BearerPumpHostClient;
} {
  const context = createRequestContextFixture({ bearerToken: "token" });
  const onChange =
    (_handler: (event: HostClientChangeEvent) => void): (() => void) =>
    () => {};
  const onBearerRotated = (handler: () => void): (() => void) => {
    fixture.rotations.add(handler);
    return () => fixture.rotations.delete(handler);
  };
  return {
    hostClient: {
      getRequestContext: (): RequestContext => context,
      onChange,
      onBearerRotated,
    },
  };
}

function mainEvents(pair: FakeBridgePair): MainToWorkerEvent[] {
  return pair.fromMain.flatMap((post) => {
    if (!isMainToWorkerFrame(post.delivered)) return [];
    return post.delivered.frame === "event" ? [post.delivered.event] : [];
  });
}

describe("spawnEpicRuntimeWorker", () => {
  it("resolves ready after a real host answers the handshake", async () => {
    const fixture = createFixture(true);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const { hostClient } = createHostClient(fixture);
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { hostClient, relay },
      ),
    );

    await expect(handle.ready).resolves.toBeUndefined();
    // All three, by name and in order. Nothing the worker owns may dial before
    // it has an address AND a credential, and the handshake has to precede
    // both - a `slice(0, 2)` here would have stayed green when the endpoint
    // push was added and silently stopped covering the bearer.
    expect(
      mainEvents(fixture.pair)
        .slice(0, 3)
        .map((event) => event.kind),
    ).toEqual(["bootstrap", "endpoint", "bearer"]);
    handle.dispose();
    fixture.host?.shutdown();
  });

  it("carries the host and user it was spawned for in the bootstrap", () => {
    const fixture = createFixture(false);
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { hostId: "host-7", userId: "user-7" },
      ),
    );

    const [first] = mainEvents(fixture.pair);
    expect(first).toEqual({
      kind: "bootstrap",
      bootstrap: {
        protocolVersion: 1,
        hostId: "host-7",
        userId: "user-7",
        windowLabel: "window-1",
      },
    });
    handle.dispose();
  });

  it("relays worker logs and fatal events, rejecting an unresolved ready", async () => {
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const { hostClient } = createHostClient(fixture);
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { hostClient, relay },
      ),
    );
    const logEntry = {
      level: "debug" as const,
      message: "hello",
      fields: { windowLabel: "window-1" },
      error: null,
    };

    fixture.pair.worker.post(
      { frame: "event", event: { kind: "log", entry: logEntry } },
      [],
    );
    fixture.pair.worker.post(
      {
        frame: "event",
        event: { kind: "fatal", message: "worker failed", stack: "stack" },
      },
      [],
    );

    expect(relay.log).toHaveBeenCalledWith(logEntry);
    expect(relay.fatal).toHaveBeenCalledWith("worker failed", "stack");
    await expect(handle.ready).rejects.toThrow("worker failed");
    handle.dispose();
  });

  it("routes a host-recovered event to the caller's notifier", () => {
    const fixture = createFixture(false);
    const onHostRecovered = vi.fn();
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { onHostRecovered },
      ),
    );

    fixture.pair.worker.post(
      { frame: "event", event: { kind: "host-recovered" } },
      [],
    );

    // Fire-and-forget: the worker gets no answer, and the selection authority
    // on this side decides what recovery means. A call here would have made
    // the worker's transport wait on a decision it has no stake in.
    expect(onHostRecovered).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("disposes idempotently by sending shutdown before terminating", async () => {
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const { hostClient } = createHostClient(fixture);
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { hostClient, relay },
      ),
    );

    handle.dispose();
    handle.dispose();

    const events = mainEvents(fixture.pair);
    expect(events.at(-1)).toEqual({ kind: "shutdown" });
    expect(fixture.terminate).toHaveBeenCalledTimes(1);
    await expect(handle.ready).rejects.toThrow("disposed before it was ready");
  });

  it("stops bearer pushes after disposal", () => {
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const { hostClient } = createHostClient(fixture);
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { hostClient, relay },
      ),
    );
    const count = fixture.pair.fromMain.length;

    handle.dispose();
    for (const handler of [...fixture.rotations]) handler();

    expect(fixture.pair.fromMain).toHaveLength(count + 1);
  });

  it("stops endpoint pushes after disposal", () => {
    const fixture = createFixture(false);
    const changes = new Set<() => void>();
    let endpointUrl: string | null = "ws://one";
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        {
          endpoint: () => ({ hostId: "host-1", websocketUrl: endpointUrl }),
          subscribeEndpointChange: (onChange) => {
            changes.add(onChange);
            return () => changes.delete(onChange);
          },
        },
      ),
    );
    const count = fixture.pair.fromMain.length;

    handle.dispose();
    endpointUrl = "ws://two";
    for (const handler of [...changes]) handler();

    // Only the shutdown event. The directory outlives the worker, so a pump
    // that survived disposal would keep posting into a terminated thread.
    expect(fixture.pair.fromMain).toHaveLength(count + 1);
  });
});

describe("spawnEpicRuntimeWorker — the two worker->main calls", () => {
  function setupCalls(
    overrides: Partial<SpawnEpicRuntimeWorkerOptions<never>>,
  ) {
    const pair = createFakeBridgePair("queued");
    const worker: RuntimeWorkerLike = {
      ...attachWorkerTarget(pair),
      terminate: () => {},
    };
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => worker, projection: SILENT_PROJECTION },
        overrides,
      ),
    );
    // The REAL worker-side endpoint, so the frames, the correlation and the
    // response parsers are all production code. A hand-built `main-call` frame
    // would have proved the main side answers something, not that the two ends
    // agree on what.
    const workerEndpoint = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );
    return { pair, handle, workerEndpoint };
  }

  it("answers a revalidate from the instance it was handed, calling it once", async () => {
    const revalidateForReconnect = vi.fn(() => Promise.resolve("rotated"));
    const auth: StreamAuthRevalidator = { revalidateForReconnect };
    const { pair, handle, workerEndpoint } = setupCalls({ auth });

    const answered = workerEndpoint.call("main/auth-revalidate", {});
    await pair.flush();

    await expect(answered).resolves.toEqual({ outcome: "rotated" });
    // IDENTITY, not shape. A shape assertion passes just as happily against a
    // second revalidator the spawner constructed for itself - which is exactly
    // the defect this call exists to prevent, because the single-flight that
    // stops 13 consumers stampeding one refresh is a property of the INSTANCE.
    expect(auth.revalidateForReconnect).toBe(revalidateForReconnect);
    expect(revalidateForReconnect).toHaveBeenCalledTimes(1);
    handle.dispose();
    workerEndpoint.dispose();
  });

  it("answers a mint from the flow it was handed, forwarding the request", async () => {
    const mint = vi.fn(() =>
      Promise.resolve({ kind: "pending-elsewhere", retryAfterMs: 1_500 }),
    );
    const { pair, handle, workerEndpoint } = setupCalls({ mint });

    const answered = workerEndpoint.call("main/mint-credential", {
      mint: { hostId: "host-1", reason: "needs-reauth" },
    });
    await pair.flush();

    await expect(answered).resolves.toEqual({
      outcome: { kind: "pending-elsewhere", retryAfterMs: 1_500 },
    });
    expect(mint).toHaveBeenCalledTimes(1);
    // The request crosses intact: the flow is single-flighted PER HOST, so a
    // spawner that dropped or rewrote `hostId` would join the wrong host's
    // attempt - or start a second one for a host that already has one.
    expect(mint).toHaveBeenCalledWith({
      hostId: "host-1",
      reason: "needs-reauth",
    });
    handle.dispose();
    workerEndpoint.dispose();
  });

  it("reports a throwing handler as a rejection rather than hanging the worker", async () => {
    const auth: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.reject(new Error("auth exploded")),
    };
    const { pair, handle, workerEndpoint } = setupCalls({ auth });

    const answered = workerEndpoint.call("main/auth-revalidate", {});
    // The worker's transport awaits this deep inside a reconnect. A main-side
    // throw that produced no frame would park that reconnect forever, on a
    // thread with no `unhandledrejection` anyone reads.
    //
    // Attached before the flush, so the rejection is observed as it happens
    // rather than surviving a macrotask boundary unhandled.
    const rejected = expect(answered).rejects.toThrow("auth exploded");
    await pair.flush();
    await rejected;
    handle.dispose();
    workerEndpoint.dispose();
  });
});

interface Slice {
  readonly title: string;
}

/**
 * The projection path END TO END: a worker emitting `projection` frames, the
 * spawner's one reducer, and the handlers the composition root supplies.
 *
 * The reducer's own suite lives in `clients/shared` and passes whether or not
 * the spawner ever calls it — which is exactly the gap these pins close. What
 * is under test here is the WIRING.
 */
describe("spawnEpicRuntimeWorker — the projection path", () => {
  function setupProjection() {
    const pair = createFakeBridgePair("sync");
    const worker: RuntimeWorkerLike = {
      ...attachWorkerTarget(pair),
      terminate: () => {},
    };

    const applied: Array<{ readonly value: Slice; readonly revision: number }> =
      [];
    const rejected: Array<{
      readonly reason: string;
      readonly revision: number;
    }> = [];
    const handle = spawnEpicRuntimeWorker<Slice>(
      spawnOptions<Slice>(
        {
          createWorker: () => worker,
          projection: {
            accept: (value) =>
              typeof value === "object" &&
              value !== null &&
              "title" in value &&
              typeof value.title === "string"
                ? { title: value.title }
                : null,
            apply: (value, revision) => applied.push({ value, revision }),
            reject: (reason, revision) => rejected.push({ reason, revision }),
          },
        },
        {},
      ),
    );

    const publish = (revision: number, value: unknown): void => {
      pair.worker.post(
        { frame: "event", event: { kind: "projection", revision, value } },
        [],
      );
    };
    return { applied, rejected, publish, handle };
  }

  it("delivers ordered publications through to apply", () => {
    const { applied, publish, handle } = setupProjection();

    publish(1, { title: "a" });
    publish(2, { title: "b" });

    expect(applied).toEqual([
      { value: { title: "a" }, revision: 1 },
      { value: { title: "b" }, revision: 2 },
    ]);
    handle.dispose();
  });

  it("drops a stale revision rather than rolling the slice back", () => {
    const { applied, rejected, publish, handle } = setupProjection();

    publish(2, { title: "b" });
    publish(1, { title: "a" });

    expect(applied).toEqual([{ value: { title: "b" }, revision: 2 }]);
    expect(rejected).toEqual([{ reason: "stale", revision: 1 }]);
    handle.dispose();
  });

  it("drops a re-delivery of the revision it just applied", () => {
    const { applied, rejected, publish, handle } = setupProjection();

    publish(2, { title: "b" });
    publish(2, { title: "b-again" });

    expect(applied).toEqual([{ value: { title: "b" }, revision: 2 }]);
    expect(rejected).toEqual([{ reason: "stale", revision: 2 }]);
    handle.dispose();
  });

  it("does not advance the watermark on a frame it could not narrow", () => {
    const { applied, rejected, publish, handle } = setupProjection();

    publish(1, { nope: 1 });
    publish(1, { title: "a" });

    expect(rejected).toEqual([{ reason: "unrecognised", revision: 1 }]);
    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);
    handle.dispose();
  });
});
