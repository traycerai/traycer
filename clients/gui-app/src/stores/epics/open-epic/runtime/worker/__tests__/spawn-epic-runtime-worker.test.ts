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
import { buildProxiedRuntimeFactories } from "../install-epic-runtime-core";
import {
  readEpicAdapterVerdict,
  type EpicAdapterVerdict,
} from "../../epic-adapter-selection";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { StreamMethodSupportSource } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";

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
          retryAfterMs: null,
        },
      }),
    laneUnary: () =>
      Promise.resolve({
        ok: false,
        reason: "no lane unary transport in this fixture",
      }),
    // Nothing negotiated. `"unknown"` is the honest fixture answer and it is
    // also what the manifest this spawner now emits will carry - which is a
    // fact these tests can assert on rather than a stub that hides one.
    methodSupport: {
      getMethodSupport: () => "unknown",
      subscribeMethodSupport: () => () => {},
    },
    hostId: "host-1",
    windowLabel: "window-1",
    body: { applyDocUpdate: () => {}, applyAwareness: () => {} },
  };
  return { ...base, ...overrides };
}

interface SpawnFixture {
  readonly pair: FakeBridgePair;
  readonly worker: RuntimeWorkerLike;
  readonly terminate: () => void;
  readonly host: EpicRuntimeWorkerHost | null;
  /**
   * Fires the DOM-level fault a real `Worker` reports when its module fails to
   * load - the one failure the bridge cannot carry, because no code of ours
   * ever runs to send a `fatal`.
   *
   * A recorded listener rather than a no-op, so this fixture can drive the
   * path instead of merely satisfying its type.
   */
  readonly faultWorker: (message: string) => void;
}

function createFixture(withHost: boolean): SpawnFixture {
  const pair = createFakeBridgePair("sync");
  const terminate = vi.fn();
  const faultListeners: Array<(message: string) => void> = [];
  const worker: RuntimeWorkerLike = {
    ...createFakeWorkerTarget(pair),
    terminate,
    onWorkerFault: (listener) => {
      faultListeners.push(listener);
    },
  };
  const host = withHost ? startEpicRuntimeWorkerHost(pair.worker) : null;
  return {
    pair,
    worker,
    terminate,
    host,
    faultWorker: (message) => {
      for (const listener of [...faultListeners]) listener(message);
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
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        {},
      ),
    );

    await expect(handle.ready).resolves.toBeUndefined();
    // The preamble is the handshake plus the negotiated MANIFEST, and the
    // second one arrived with a ruling: this event was declared by the protocol
    // and consumed by the worker host from the start, and no emitter was ever
    // written - which pinned every worker-hosted runtime to the fail-closed
    // legacy arm for its whole life. Nothing this spawner sends is a credential
    // or an address (the socket never left this thread), so a THIRD event here
    // would still mean a channel came back without one.
    //
    // ORDER is asserted, not just membership: the manifest follows the
    // bootstrap, because the bootstrap is the protocol handshake and a worker
    // that has not validated its version has no business acting on state.
    expect(mainEvents(fixture.pair).map((event) => event.kind)).toEqual([
      "bootstrap",
      "stream/manifest",
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

  it("surfaces a worker fault as a fatal, with no bridge traffic at all", async () => {
    // THE FAILURE THE BRIDGE CANNOT CARRY. `new Worker(url, {type:"module"})`
    // returns synchronously, so a module that then fails to fetch, parse or
    // evaluate leaves a live handle attached to a thread that never ran a line
    // of our code: no `ready`, no `fatal`, nothing to time out on. Production
    // does not await `handle.ready`, so the session is already presented as
    // ready and the epic spins on a snapshot that cannot arrive, with no Retry
    // offered.
    //
    // Driven with ZERO prior posts, deliberately - the whole point is that
    // this arrives on a bridge that has never carried a frame, so a pin that
    // handshook first would be testing a different failure.
    const fixture = createFixture(false);
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { relay },
      ),
    );

    fixture.faultWorker("the epic runtime worker module failed to load");

    // Routed through the SAME path the bridge `fatal` takes: the relay is told
    // (which is what presents `failed` and its Retry), and the handshake
    // promise is rejected rather than left pending forever.
    expect(relay.fatal).toHaveBeenCalledWith(
      "the epic runtime worker module failed to load",
      null,
    );
    await expect(handle.ready).rejects.toThrow("module failed to load");
    handle.dispose();
  });

  it("survives a fault delivered while the handle is still constructing", async () => {
    // THE TEMPORAL DEAD ZONE THE FATAL TEARDOWN OPENED. `surfaceFatal` now
    // calls `disposeHandle()`, which reads `disposed` and three unsubscribes
    // declared far BELOW the `onWorkerFault` subscription - subscribed early
    // on purpose, because a module that fails to evaluate can have faulted
    // before this handle finishes constructing. An implementation that
    // answers that by replaying the fault synchronously on subscribe would
    // hit those bindings in their TDZ, and the `ReferenceError` would come
    // out of the CONSTRUCTOR - replacing the failed presentation and the
    // rejected `ready` with a crash, which is strictly worse than the leak
    // the teardown was added to fix.
    //
    // Nothing in `RuntimeWorkerLike` forbids that implementation; the DOM
    // adapter merely happens not to be one, since `error` arrives as a task.
    // The bridge's own `fatal` reaches the same place by the other road, from
    // inside the synchronous `bootstrap` emit.
    const pair = createFakeBridgePair("sync");
    const terminate = vi.fn();
    const worker: RuntimeWorkerLike = {
      ...createFakeWorkerTarget(pair),
      terminate,
      onWorkerFault: (listener) => {
        listener("the epic runtime worker module failed to load");
      },
    };
    const relay = { log: vi.fn(), fatal: vi.fn() };

    // Construction itself is the first assertion: under the bug this throws.
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => worker, projection: SILENT_PROJECTION },
        { relay },
      ),
    );

    // The visible half still ran immediately, in the same order as a mid-life
    // fatal - the deferral moves the TEARDOWN, not the presentation.
    expect(relay.fatal).toHaveBeenCalledWith(
      "the epic runtime worker module failed to load",
      null,
    );
    // And the deferred teardown was discharged rather than dropped: a fatal
    // that only presented would leave the thread running.
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(handle.ready).rejects.toThrow("module failed to load");
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

  // RETIRED WITH ITS SUBJECT: "attach re-binds to a NEW host, leaving none open
  // on the old". `EpicRuntimeWorkerHandle.attach` is deleted - it had no callers
  // and could not have done what it promised: it re-detached (emitting a second
  // detach-transport) and installed a main-side proxy the worker never reopens
  // through, so the worker stayed detached with no sessions. Production
  // rebinding is a RESPAWN, where the retained handle merges into a new session.
  //
  // Worth naming rather than just deleting: this test was GREEN throughout, and
  // it was green because `openStreams(fixture, 2)` after the attach FABRICATED
  // the step production has no path to - the worker asking the new proxy to open
  // streams. The pin supplied the missing half of the mechanism itself, so it
  // could only ever confirm the half that worked. A green test is not evidence a
  // member is wired; this one is why the member survived twelve unwired
  // instances' worth of sweeps.

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

  it("releases the transport when the worker fatals, without waiting for a retry", () => {
    // THE LEAK THE FATAL PATH USED TO LEAVE BEHIND. `surfaceFatal` freed the
    // accounting books and presented Retry, and stopped there - so `proxy`
    // kept every real `IStreamSession` the worker had opened. Nothing else
    // collected them: the provider MARKS the handle dead rather than
    // disposing it (registry mutation belongs to the acquire effect), and
    // that pass only runs if the user retries or reopens the epic. A user who
    // does neither leaves host subscriptions live indefinitely, forwarding
    // frames toward a bridge nothing reads.
    //
    // Cap-eviction cannot stand in for it either: the registry's
    // `isEvictable` is `handle.isClean()`, which requires
    // `hostTransportStatus === "open"` - not true of a session whose runtime
    // just died.
    const fixture = createFixture(false);
    const recording = createRecordingStreamClient();
    const relay = { log: vi.fn(), fatal: vi.fn() };
    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { streams: recording.client, relay },
      ),
    );
    openStreams(fixture, 3);
    expect(recording.closedCount()).toBe(0);

    fixture.pair.worker.post(
      {
        frame: "event",
        event: { kind: "fatal", message: "runtime blew up", stack: null },
      },
      [],
    );

    // Every real session closed, and the thread stopped - no second gesture
    // from the user required.
    expect(recording.closedCount()).toBe(3);
    expect(fixture.terminate).toHaveBeenCalledTimes(1);
    // The relay still ran, and FIRST: the teardown must not cost the user the
    // presentation that carries Retry.
    expect(relay.fatal).toHaveBeenCalledWith("runtime blew up", null);
    // And the handshake still rejects with the CAUSE. `dispose()` rejects an
    // unsettled `ready` with its own "disposed before it was ready", so a
    // teardown ordered before the rejection would replace the reason with the
    // consequence.
    return expect(handle.ready).rejects.toThrow("runtime blew up");
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
      // Not driven by these pins - the projection path is bridge traffic, and
      // a faulted worker sends none. `createFixture` above is the one that
      // records the listener.
      onWorkerFault: () => {},
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

/**
 * The negotiated manifest actually crosses, and a host that upgrades under an
 * open tab moves the arm.
 *
 * `stream/manifest` was declared by the protocol and consumed by the worker
 * host, and NOTHING on main ever emitted one. That is not a missing
 * optimisation. `support(method)` answers `"unknown"` against a null manifest,
 * `"unknown"` is deliberately not a selection, and the fail-closed default is
 * the legacy `@1` arm - so every worker-hosted runtime held legacy for its
 * whole life, on lane-serving hosts included. The capability PROBE masks the
 * cold case (the status lane's own subscribe settles a connection's verdict),
 * which is exactly why this went unnoticed; what a probe cannot do is move a
 * tab whose host upgraded underneath it, because that signal exists only here.
 *
 * The chain is pinned END TO END rather than at the emit: main emits, the REAL
 * worker host applies, the PRODUCTION support reader reads what it applied, and
 * the PRODUCTION verdict function turns that into an arm. A pin that stopped at
 * "an event was posted" would have passed against a payload no reader could
 * use.
 */
/**
 * A host that serves BOTH record-list methods, at the minor that carries the
 * doc remainder. `epic.listTuiAgents` needs `@1.1` specifically - at `@1.0`
 * the host withholds doc-only entries, so the doc arm stays on - which is why
 * this names a version rather than just a method.
 */
const RECORD_SERVING_MANIFEST: ConnectionManifest = {
  "epic.listChatRecords": { major: 1, minor: 1 },
  "epic.listTuiAgents": { major: 1, minor: 1 },
};

describe("the negotiated manifest crossing to the worker", () => {
  function supportController(): {
    readonly source: StreamMethodSupportSource<HostStreamRpcRegistry>;
    set(support: StreamMethodSupport): void;
  } {
    let current: StreamMethodSupport = "unknown";
    const listeners = new Set<() => void>();
    return {
      source: {
        getMethodSupport: () => current,
        subscribeMethodSupport: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      set: (support) => {
        current = support;
        for (const listener of [...listeners]) listener();
      },
    };
  }

  /** The production reader and the production decision, over a real host. */
  function armOf(host: EpicRuntimeWorkerHost): EpicAdapterVerdict {
    const lanes = buildProxiedRuntimeFactories(host).laneSelection;
    if (lanes === null) throw new Error("the proxied factories built no lanes");
    return readEpicAdapterVerdict(lanes.support);
  }

  it("upgrades a live session from legacy to lanes when support resolves", () => {
    const fixture = createFixture(true);
    const host = fixture.host;
    if (host === null) throw new Error("the fixture built no worker host");
    const support = supportController();

    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { methodSupport: support.source },
      ),
    );

    // The INITIAL push, which `subscribeMethodSupport` alone cannot deliver:
    // it reports movement, not state, so a worker spawned onto a transport
    // whose handshake already resolved would otherwise wait for an edge that
    // has been and gone. `"unknown"` is not a selection, so the verdict is
    // undecided rather than legacy - which is the distinction the probe
    // depends on.
    expect(armOf(host)).toBe("undecided");

    support.set("supported");
    expect(armOf(host)).toBe("lanes");

    // And back through unknown, because a reconnect CLEARS the support map and
    // re-probes - the window every healthy reconnect on a lane host passes
    // through, and the one a raw digest would read as a manifest change.
    support.set("unknown");
    expect(armOf(host)).toBe("undecided");

    support.set("unsupported");
    expect(armOf(host)).toBe("legacy");

    handle.dispose();
    host.shutdown();
  });

  /**
   * The `docArm` half, which has a DIFFERENT source from the other two fields
   * and therefore a different edge.
   *
   * `methodSupport` is the stream client's learned support; `docArm` comes off
   * the negotiated-UNARY registry. Subscribing only to the first was right for
   * a reconnect - one re-handshake rewrites both - and wrong for the ordinary
   * case of the first unary handshake completing after this worker spawned,
   * which is the usual order on a warm tab. The worker then held the
   * fail-closed doc arm against a host that serves the record-list methods, so
   * it went on unioning a live root row with a poll row and a newer rename
   * stayed hidden behind the older poll value.
   *
   * The stimulus is deliberately a registry write with NO support movement -
   * `methodSupport` here is the default frozen `"unknown"` source with a no-op
   * listener, which is also literally what a relay gives - so the only thing
   * that can carry the new arm across is the registry subscription.
   */
  it("re-emits the manifest when the negotiated UNARY registry moves, with no stream-support edge at all", () => {
    resetNegotiatedManifests();
    const fixture = createFixture(true);
    const host = fixture.host;
    if (host === null) throw new Error("the fixture built no worker host");

    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        {},
      ),
    );

    // Fail-closed before any handshake: the doc is still a record source for
    // both planes, which is what `readEpicDocRecordArms(null-ish)` answers.
    expect(host.streams.manifest()?.docArm).toEqual({
      chats: true,
      tuiAgents: true,
    });

    // The first unary handshake with `host-1` completes. Nothing about STREAM
    // support changed, and nothing here could tell the worker if this were not
    // subscribed - the spawn fixture's `subscribeMethodSupport` is `() => () =>
    // {}`.
    recordNegotiatedHostManifest("host-1", RECORD_SERVING_MANIFEST);

    expect(host.streams.manifest()?.docArm).toEqual({
      chats: false,
      tuiAgents: false,
    });

    handle.dispose();
    host.shutdown();
    resetNegotiatedManifests();
  });

  it("stops listening to the negotiated registry once the handle is disposed", () => {
    resetNegotiatedManifests();
    const fixture = createFixture(true);
    const host = fixture.host;
    if (host === null) throw new Error("the fixture built no worker host");

    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        {},
      ),
    );
    handle.dispose();

    // The registry is module-scoped and PROCESS-wide, so a listener leaked
    // there outlives not just this transport but every session on it - and it
    // would emit onto a disposed bridge on every later host's handshake.
    const before = host.streams.manifest()?.docArm;
    recordNegotiatedHostManifest("host-1", RECORD_SERVING_MANIFEST);
    expect(host.streams.manifest()?.docArm).toEqual(before);

    host.shutdown();
    resetNegotiatedManifests();
  });

  it("stops pushing once the handle is disposed", () => {
    const fixture = createFixture(true);
    const host = fixture.host;
    if (host === null) throw new Error("the fixture built no worker host");
    const support = supportController();

    const handle = spawnEpicRuntimeWorker(
      spawnOptions(
        { createWorker: () => fixture.worker, projection: SILENT_PROJECTION },
        { methodSupport: support.source },
      ),
    );
    handle.dispose();

    // The TRANSPORT outlives this worker on the retained-buffer path, so a
    // listener left behind would emit onto a disposed bridge every time that
    // connection re-handshakes. Observed through the reader rather than by
    // counting posts: what matters is that the worker's view stopped moving.
    const before = armOf(host);
    support.set("supported");
    expect(armOf(host)).toBe(before);

    host.shutdown();
  });
});
