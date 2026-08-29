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
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
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

interface SpawnFixture {
  readonly pair: FakeBridgePair;
  readonly worker: RuntimeWorkerLike;
  readonly terminate: () => void;
  readonly host: EpicRuntimeWorkerHost | null;
  readonly rotations: Set<() => void>;
}

function createFixture(withHost: boolean): SpawnFixture {
  const pair = createFakeBridgePair("sync");
  const rotations = new Set<() => void>();
  const terminate = vi.fn();
  const workerListeners = new Set<(event: BridgeMessageEventLike) => void>();
  pair.main.subscribe((message) => {
    const event: BridgeMessageEventLike = { data: message };
    for (const listener of [...workerListeners]) listener(event);
  });
  const target: BridgeMessageTargetLike = {
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
  const worker: RuntimeWorkerLike = { ...target, terminate };
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
    const handle = spawnEpicRuntimeWorker({
      createWorker: () => fixture.worker,
      hostClient,
      projection: SILENT_PROJECTION,
      relay,
      windowLabel: "window-1",
    });

    await expect(handle.ready).resolves.toBeUndefined();
    expect(
      mainEvents(fixture.pair)
        .slice(0, 2)
        .map((event) => event.kind),
    ).toEqual(["bootstrap", "bearer"]);
    handle.dispose();
    fixture.host?.shutdown();
  });

  it("relays worker logs and fatal events, rejecting an unresolved ready", async () => {
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const { hostClient } = createHostClient(fixture);
    const handle = spawnEpicRuntimeWorker({
      createWorker: () => fixture.worker,
      hostClient,
      projection: SILENT_PROJECTION,
      relay,
      windowLabel: "window-1",
    });
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

  it("disposes idempotently by sending shutdown before terminating", async () => {
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const { hostClient } = createHostClient(fixture);
    const handle = spawnEpicRuntimeWorker({
      createWorker: () => fixture.worker,
      hostClient,
      projection: SILENT_PROJECTION,
      relay,
      windowLabel: "window-1",
    });

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
    const handle = spawnEpicRuntimeWorker({
      createWorker: () => fixture.worker,
      hostClient,
      projection: SILENT_PROJECTION,
      relay,
      windowLabel: "window-1",
    });
    const count = fixture.pair.fromMain.length;

    handle.dispose();
    for (const handler of [...fixture.rotations]) handler();

    expect(fixture.pair.fromMain).toHaveLength(count + 1);
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
    const workerListeners = new Set<(event: BridgeMessageEventLike) => void>();
    pair.main.subscribe((message) => {
      const event: BridgeMessageEventLike = { data: message };
      for (const listener of [...workerListeners]) listener(event);
    });
    const target: BridgeMessageTargetLike = {
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
    const worker: RuntimeWorkerLike = { ...target, terminate: () => {} };

    const applied: Array<{ readonly value: Slice; readonly revision: number }> =
      [];
    const rejected: Array<{
      readonly reason: string;
      readonly revision: number;
    }> = [];
    const handle = spawnEpicRuntimeWorker<Slice>({
      createWorker: () => worker,
      hostClient: {
        getRequestContext: () => null,
        onChange: () => () => {},
        onBearerRotated: () => () => {},
      },
      relay: { log: () => {}, fatal: () => {} },
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
      windowLabel: "window-1",
    });

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
