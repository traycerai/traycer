import { describe, expect, it, vi } from "vitest";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { createFakeWorkerTarget } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-worker-target";
import {
  isMainToWorkerFrame,
  type MainToWorkerEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { createRecordingAccountingPort } from "@/stores/epics/open-epic/test-support/accounting-port-fixture";
import { createRecordingStreamClient } from "@traycer-clients/shared/replica-runtime/worker/test-support/recording-stream-client";
import type { RuntimeProjectionHandlers } from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";
import {
  startEpicRuntimeWorkerHost,
  type EpicRuntimeWorkerHost,
} from "../epic-runtime-worker-host";
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

/**
 * One construction site for the spawner's options.
 *
 * `SpawnEpicRuntimeWorkerOptions` MIRRORS what the worker needs from the main
 * thread, so it grows every time a channel is added - this file had SIX
 * literals when the worker->main direction landed, which was six compile errors
 * for one ruling and six more when that ruling was withdrawn. One site makes
 * the next such change one failure.
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
    relay: { log: () => {}, fatal: () => {} },
    accounting: createRecordingAccountingPort().port,
    epicId: "epic-fixture",
    streams: createRecordingStreamClient().client,
    writeCommand: () =>
      Promise.resolve({
        ok: false,
        failure: {
          kind: "queued",
          reason: "no write transport in this fixture",
          boundedRetry: false,
        },
      }),
    windowLabel: "window-1",
  };
  return { ...base, ...overrides };
}

interface SpawnFixture {
  readonly pair: FakeBridgePair;
  readonly worker: RuntimeWorkerLike;
  readonly terminate: () => void;
  readonly host: EpicRuntimeWorkerHost | null;
}

function createFixture(withHost: boolean): SpawnFixture {
  const pair = createFakeBridgePair("sync");
  const terminate = vi.fn();
  const worker: RuntimeWorkerLike = {
    ...createFakeWorkerTarget(pair),
    terminate,
  };
  const host = withHost ? startEpicRuntimeWorkerHost(pair.worker) : null;
  return { pair, worker, terminate, host };
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
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        {},
      ),
    );

    await expect(handle.ready).resolves.toBeUndefined();
    // The handshake is the WHOLE preamble now. Nothing this spawner sends is a
    // credential or an address any more - the socket never left this thread -
    // so a second event here would mean a channel came back without a ruling.
    expect(mainEvents(fixture.pair).map((event) => event.kind)).toEqual([
      "bootstrap",
    ]);
    handle.dispose();
    fixture.host?.shutdown();
  });

  it("relays worker logs and fatal events, rejecting an unresolved ready", async () => {
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { relay },
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

  it("disposes idempotently by sending shutdown before terminating", async () => {
    const fixture = createFixture(false);
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        {},
      ),
    );

    handle.dispose();
    handle.dispose();

    const events = mainEvents(fixture.pair);
    expect(events.at(-1)).toEqual({ kind: "shutdown" });
    expect(fixture.terminate).toHaveBeenCalledTimes(1);
    await expect(handle.ready).rejects.toThrow("disposed before it was ready");
  });

  /** Opens `count` streams through the handle's bridge and returns the events. */
  function openStreams(fixture: SpawnFixture, count: number): void {
    for (let streamId = 1; streamId <= count; streamId += 1) {
      fixture.pair.worker.post(
        {
          frame: "event",
          event: {
            kind: "stream/open",
            open: {
              streamId,
              method: "epic.status.subscribe",
              params: { epicId: `epic-${String(streamId)}` },
              withParamsProvider: false,
            },
          },
        },
        [],
      );
    }
  }

  function closeReportsTo(fixture: SpawnFixture): MainToWorkerEvent[] {
    return mainEvents(fixture.pair).filter(
      (event) => event.kind === "stream/status",
    );
  }

  it("detach reports every close to a worker that SURVIVES", () => {
    // Path 2 (`detachTransport`): the transport ends, the replica does not. The
    // reports are the only signal the surviving worker gets - without them its
    // streams merely go quiet, which is indistinguishable from a slow host.
    const fixture = createFixture(false);
    const recording = createRecordingStreamClient();
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { streams: recording.client },
      ),
    );
    openStreams(fixture, 3);

    handle.detach();

    expect(recording.closedCount()).toBe(3);
    // Through the HANDLE and over the real bridge - the ordering bug this pin
    // exists for was invisible to a pin that drove the proxy host directly.
    expect(closeReportsTo(fixture)).toHaveLength(3);
    // The worker is untouched: no shutdown, no terminate.
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(
      mainEvents(fixture.pair).some((event) => event.kind === "shutdown"),
    ).toBe(false);
    handle.dispose();
  });

  it("attach re-binds to a NEW host, leaving none open on the old", () => {
    const fixture = createFixture(false);
    const first = createRecordingStreamClient();
    const second = createRecordingStreamClient();
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { streams: first.client },
      ),
    );
    openStreams(fixture, 2);

    handle.attach(second.client);
    openStreams(fixture, 2);

    // Zero left on the old, both on the new. A host that SWAPPED its client
    // instead of being replaced would have the two generations' worker-assigned
    // `streamId`s colliding in one map.
    expect(first.closedCount()).toBe(2);
    expect(second.opened()).toHaveLength(2);
    expect(second.closedCount()).toBe(0);
    handle.dispose();
  });

  it("dispose reports every close BEFORE it tears the bridge down", () => {
    const fixture = createFixture(false);
    const recording = createRecordingStreamClient();
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { streams: recording.client },
      ),
    );
    openStreams(fixture, 2);

    handle.dispose();

    expect(recording.closedCount()).toBe(2);
    // Both reports landed, and the shutdown came AFTER them. Tearing down
    // first posts them into a disposed bridge, where they are dropped - which
    // is what shipped, and what a proxy-level pin could not see.
    const kinds = mainEvents(fixture.pair).map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "stream/status")).toHaveLength(2);
    expect(kinds.lastIndexOf("stream/status")).toBeLessThan(
      kinds.indexOf("shutdown"),
    );
  });

  it("closes every real session the worker opened when it disposes", () => {
    // Rule 3: a worker that is terminated mid-life never sends its own closes.
    // A real session left subscribed is a socket carrying frames nothing reads.
    const fixture = createFixture(false);
    const recording = createRecordingStreamClient();
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { streams: recording.client },
      ),
    );

    for (const streamId of [1, 2, 3]) {
      fixture.pair.worker.post(
        {
          frame: "event",
          event: {
            kind: "stream/open",
            open: {
              streamId,
              method: "epic.status.subscribe",
              params: { epicId: "epic-1" },
              withParamsProvider: false,
            },
          },
        },
        [],
      );
    }
    expect(recording.opened()).toHaveLength(3);
    expect(recording.closedCount()).toBe(0);

    handle.dispose();

    // N opened, N closed, none leaked.
    expect(recording.closedCount()).toBe(3);
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
      ...createFakeWorkerTarget(pair),
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
