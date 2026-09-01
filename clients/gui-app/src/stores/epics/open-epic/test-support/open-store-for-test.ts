/**
 * The ONE wiring that opens a store against an in-process runtime worker.
 *
 * `createOpenEpicStore` stopped constructing a runtime: the composition root
 * lives in the worker, and the session provider spawns it. A suite that used
 * to hand the store a fake `streamClientFactory` therefore has nothing to hand
 * it — so this does what the provider does, with the test's factories supplied
 * to the composition instead of the proxy-built ones.
 *
 * That injection is a seam the design already had.
 * `epic-runtime-composition.ts` states it: the factories are "an option rather
 * than something this module derives, and that is one seam with two users
 * rather than a testing convenience: the production bootstrap passes the
 * proxy-built ones, and a caller that supplies its own stream (the provider's
 * override seam, and `store.test.ts`'s fake) passes those."
 *
 * **What these tests now exercise that they did not before.** The old path
 * handed a fake factory straight to an in-process runtime. This one runs the
 * REAL worker host, the REAL core, the REAL composition root and the REAL
 * bridge dispatch on every test, over a `structuredClone`-ing pipe that
 * genuinely detaches transferred buffers and throws on an unclonable payload.
 * It is a strict superset of the old bypass: everything the old path covered,
 * plus the boundary. What stays faked is the wire beneath the typed clients —
 * the decode itself is covered from the other side by the boot probe and by
 * owed #4's equality pin.
 *
 * One helper, not a pattern to copy. A second wiring is a second harness to
 * keep honest, and the two would drift in exactly the places that matter.
 */
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { RuntimeWorkerPort } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import type { EpicReplicaRuntime } from "../runtime/epic-replica-runtime";
import {
  createInProcessEpicRuntimeWorker,
  type FakeBridgeDelivery,
  type InProcessEpicRuntimeWorker,
} from "./in-process-epic-runtime-worker";
import { createRecordingStreamClient } from "@traycer-clients/shared/replica-runtime/worker/test-support/recording-stream-client";

import {
  createOpenEpicStore,
  isProjectionPatch,
  type OpenEpicStoreHandle,
} from "../store";
import { createProcessBackedAccountingPort } from "../runtime/process-backed-accounting-port";
import { createRendererRuntimeEnvironment } from "../runtime/runtime-environment";
import { spawnEpicRuntimeWorker } from "../runtime/worker/spawn-epic-runtime-worker";
import { createLateBoundProjectionTarget } from "../runtime/worker/late-bound-projection-target";
import type { EpicRuntimeStreamFactories } from "../runtime/worker/epic-runtime-composition";
import type { EpicRuntimeProjection } from "../runtime/epic-runtime-projection";
import {
  readWriteCommandIntent,
  type EpicWriteCommandIntent,
} from "../runtime/epic-write-command";

export interface OpenStoreForTestOptions {
  readonly epicId: string;
  readonly userId: string | null;
  /**
   * The suite's own stream factories — what used to be
   * `createOpenEpicStore`'s `streamClientFactory` and `laneSelection`, now
   * supplied to the composition that actually builds a runtime.
   */
  readonly factories: EpicRuntimeStreamFactories;
  /**
   * Answers `main/write-command`. Defaults would hide which suites depend on a
   * write path, so this is explicit — `null` means "this suite never writes",
   * and a write in one that said so fails rather than resolving quietly.
   */
  readonly writeCommand:
    | ((
        commandId: string,
        intent: EpicWriteCommandIntent,
      ) => Promise<{ readonly hostId: string }>)
    | null;
}

/**
 * The handle itself, plus the pipe control.
 *
 * The handle is SPREAD rather than nested so a migrating suite changes its
 * construction line and nothing else - `opened.store`, `opened.dispose()` and
 * every assertion below them keep working. That is what makes this migration
 * setup-only rather than a rewrite.
 */
export interface OpenedStoreForTest extends OpenEpicStoreHandle {
  /**
   * Deliver everything queued on the pipe, and everything that causes.
   *
   * Exposed because the boundary is real: a call posted to the worker is
   * answered a microtask later, so a test that asserts immediately after a
   * mutation is asserting on a frame still in flight.
   */
  flush(): Promise<void>;
  /**
   * The root replica's live doc and awareness, from the IN-PROCESS worker.
   *
   * These left `OpenEpicStoreHandle` because production's runtime is on
   * another thread and a `Y.Doc` cannot cross it. They are here because this
   * harness BUILT the runtime in this thread - a suite reading a doc it
   * constructed itself is not production reaching across a boundary, and
   * seeding through it is how these suites have always driven the replica.
   *
   * Named `doc` and `awareness` so a migrating suite's assertion lines do not
   * move; the construction line is the only thing that changes.
   */
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * The composed replica runtime itself, and the port the bridge reaches it by.
   *
   * For ONE caller: the arm-equality pin, which has to build a SECOND set of
   * core ports over this same runtime so that the direct call and the bridged
   * call differ in the bridge and nothing else. Reaching the runtime is the
   * requirement, not a convenience - a pin that compared two runtimes would be
   * comparing two of everything.
   *
   * Not a general accessor, and the header's "one helper, not a pattern to
   * copy" applies inside this file too: a suite that reads `runtime` to assert
   * something the STORE also projects is asserting past the boundary 4e exists
   * to draw, and should read the store. `doc` and `awareness` above are the
   * sanctioned reads for seeding.
   */
  readonly runtime: EpicReplicaRuntime;
  readonly workerPort: RuntimeWorkerPort;
  /**
   * How many times the store has asked its owner to rebuild the transport.
   *
   * The harness answers `onRetryTransport` itself instead of taking it as a
   * per-suite option, and that is not the "defaults hide which suites depend
   * on a path" shortcut `writeCommand` above refuses. There is exactly one
   * thing a test can do with this callback: production's implementation tears
   * the session down and builds a new one, which is the SESSION PROVIDER's
   * job and something this harness has no counterpart for. So the request is
   * the whole observable - `retryTransport` is a request the store may
   * refuse, and the refusal is what its data-loss gate exists to produce.
   */
  retryTransportRequests(): number;
}

export function openStoreForTest(
  options: OpenStoreForTestOptions,
): OpenedStoreForTest {
  // The worker side, in this thread: the real host with a real core, given the
  // suite's factories in place of the proxy-built ones. Through the SHARED
  // helper, not inline - the provider suites need the identical construction
  // at the `__setEpicRuntimeWorkerFactoryForTests` seam, and two copies of it
  // is the drift this file's own header warns about.
  return openStoreOver(
    createInProcessEpicRuntimeWorker(options.factories),
    options,
    "sync",
  );
}

/**
 * The identical wiring over a QUEUED bridge, for suites that need to control
 * interleaving rather than have the pipe settle each call before the next.
 *
 * Everything below the pipe is the same objects - same host, same core, same
 * dispatch - so a difference between the two is a difference in ORDERING and
 * nothing else. That is the whole point: a concurrency defect on this seam is
 * invisible to the sync pipe, because the sync pipe answers each call before
 * the next caller starts.
 *
 * `flush()` is the only thing that moves a frame here, so a suite using this
 * must drive it explicitly.
 */
export function openStoreForTestWithQueuedBridge(
  options: OpenStoreForTestOptions,
): OpenedStoreForTest {
  return openStoreOver(
    createInProcessEpicRuntimeWorker(options.factories),
    options,
    "queued",
  );
}

function openStoreOver(
  inProcessWorker: InProcessEpicRuntimeWorker,
  options: OpenStoreForTestOptions,
  deliveryAfterComposition: FakeBridgeDelivery,
): OpenedStoreForTest {
  const accounting = createProcessBackedAccountingPort({
    hostId: "test-host",
    epicId: options.epicId,
    environment: createRendererRuntimeEnvironment(),
  });

  // The SAME helper the provider uses, not a copy of its wiring: the two held
  // identical inline slots before, which is how they would drift. Buffers what
  // the worker publishes during composition - which happens inside the spawn
  // below, over this synchronous pipe.
  const projection = createLateBoundProjectionTarget<
    Partial<EpicRuntimeProjection>
  >(
    (value) => (isProjectionPatch(value) ? value : null),
    () => {
      // A suite that cares asserts on the store; a pre-attach rejection here
      // is not something a test can act on.
    },
  );
  // Late-bound for the same reason `projectionTarget` is: the worker is
  // spawned before the store that owns the live body docs exists, so the
  // return leg cannot be handed over at spawn time. Both latches close on the
  // next line after `createOpenEpicStore` returns.
  // NOT buffered, and derived rather than assumed. The body return leg
  // publishes only from observers attached inside the `body/materialize`
  // handler (`epic-runtime-core-ports.ts` - both call sites, the cold arm
  // and the forward-only one). A materialize is a CALL issued by the lease
  // bridge, and the lease bridge is built by the store - so no body
  // publication can precede the store, and this slot has no gap to lose
  // traffic in. Contrast the projection slot above, whose producer runs
  // during composition.
  let bodyTarget: OpenEpicStoreHandle["body"] | null = null;
  const worker = spawnEpicRuntimeWorker<Partial<EpicRuntimeProjection>>({
    createWorker: () => inProcessWorker.createWorker(),
    relay: { log: () => {}, fatal: () => {} },
    writeCommand: async (commandId, intent) => {
      if (options.writeCommand === null) {
        return {
          ok: false,
          failure: {
            kind: "rejected",
            resolution: {
              kind: "rejected",
              code: "RPC_ERROR",
              reason: "this suite declared no write transport",
              retryable: false,
            },
          },
        };
      }
      // Narrowed, not cast: the intent crosses as `unknown` and the suite's
      // handler is typed. A malformed one is REFUSED rather than forced.
      const narrowed = readWriteCommandIntent(intent);
      if (narrowed === null) {
        return {
          ok: false,
          failure: {
            kind: "rejected",
            resolution: {
              kind: "rejected",
              code: "RPC_ERROR",
              reason: "unrecognised write command intent",
              retryable: false,
            },
          },
        };
      }
      const sent = await options.writeCommand(commandId, narrowed);
      return { ok: true, hostId: sent.hostId };
    },
    // UNREACHABLE in this harness, and answered rather than defaulted so it
    // stays that way. `main/lane-unary` is issued only by the factories
    // `buildProxiedRuntimeFactories` builds; this harness supplies the SUITE's
    // factories, whose `unaries` the suite owns. A suite that somehow reaches
    // this learns why from the refusal instead of watching a promise never
    // settle.
    laneUnary: () =>
      Promise.resolve({
        ok: false,
        reason:
          "openStoreForTest composes the suite's own lane unaries; this bridge handler is not the path",
      }),
    streams: createRecordingStreamClient().client,
    // Nothing negotiated, which is what `"unknown"` means - and inert here for
    // the same reason `laneUnary` is: the composition reads the suite's
    // `laneSelection.support`, not this. What it DOES feed is the manifest's
    // `docArm`, and an unrecorded host answers "the doc is still a source",
    // which is the value this harness has always run with.
    methodSupport: {
      getMethodSupport: () => "unknown",
      subscribeMethodSupport: () => () => {},
    },
    accounting,
    projection: projection.handlers,
    body: {
      applyDocUpdate: (docKey, update) => {
        bodyTarget?.applyDocUpdate(docKey, update);
      },
      applyAwareness: (docKey, frame) => {
        bodyTarget?.applyAwareness(docKey, frame);
      },
    },
    epicId: options.epicId,
    // The SAME host id the accounting port above is built with, not a second
    // literal: the worker's write-command queue reads this as its send gate,
    // and a harness whose two halves named different hosts would attribute
    // commands to a host its own books never charged.
    hostId: "test-host",
    windowLabel: "test-window",
  });

  let retryTransportRequests = 0;
  const handle = createOpenEpicStore({
    epicId: options.epicId,
    userId: options.userId,
    accounting,
    onRetryTransport: () => {
      retryTransportRequests += 1;
    },
    runtime: {
      port: worker.port,
      command: (command) => {
        worker.command(command);
      },
      awarenessOut: (docKey, frame, localClientId) => {
        worker.awarenessOut(docKey, frame, localClientId);
      },
      currentUser: (nextUserId) => {
        worker.currentUser(nextUserId);
      },
      detach: () => {
        worker.detach();
      },
      dispose: () => {
        worker.dispose();
      },
    },
  });
  projection.attach(handle.projection);
  bodyTarget = handle.body;

  const runtime = inProcessWorker.composedRuntime();
  if (runtime === null) {
    // The bootstrap is emitted synchronously by `spawnEpicRuntimeWorker` over
    // a `"sync"` pipe, so this is unreachable - and it is checked rather than
    // asserted, because a harness that silently handed back a doc-less handle
    // would fail somewhere far from the cause.
    throw new Error("[openStoreForTest] the worker composed no runtime");
  }
  // The flip, and it lives HERE rather than in a suite: composition is done, so
  // everything after this is the behaviour under test. A suite that flipped for
  // itself would be doing setup the entry point already owns, and one that
  // constructed a queued pair would not get this far - see
  // `FakeBridgePair.setDelivery`.
  inProcessWorker.setDelivery(deliveryAfterComposition);
  return {
    ...handle,
    flush: () => inProcessWorker.flush(),
    // ADDED here, not carried by the spread above: `doc` and `awareness` are
    // not members of `OpenEpicStoreHandle` at all - they left that interface
    // when the runtime moved into the worker, and this harness is the only
    // caller still holding the composed runtime directly, so it is the only
    // one that can offer them.
    //
    // GETTERS rather than captured values, because the runtime REPLACES the
    // replica underneath them - a viewer downgrade, a fresh snapshot, an
    // authority-epoch change - and driving exactly those replacements is what
    // these suites are for. Reading `runtime.doc` once here would hand a suite
    // a doc that is destroyed the moment it exercises the behaviour it was
    // written to cover, with the live one unreachable and no assertion able to
    // tell the difference.
    get doc(): Y.Doc {
      return runtime.doc;
    },
    get awareness(): Awareness {
      return runtime.awareness;
    },
    // A plain value, not a getter, and the asymmetry with `doc`/`awareness`
    // above is the point: those two are REPLACED when the replica is (a viewer
    // downgrade, a fresh snapshot), which is why they must be re-read. The
    // composition itself is not - `installEpicRuntimeCore` builds it once per
    // bootstrap and this harness bootstraps once.
    runtime,
    workerPort: worker.port,
    retryTransportRequests: () => retryTransportRequests,
  };
}
