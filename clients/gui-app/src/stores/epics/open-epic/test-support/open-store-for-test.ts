/** The ONE wiring that opens a store against an in-process runtime worker. */
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
  readonly factories: EpicRuntimeStreamFactories;
  /** Answers `main/write-command`. */
  readonly writeCommand:
    | ((
        commandId: string,
        intent: EpicWriteCommandIntent,
      ) => Promise<{ readonly hostId: string }>)
    | null;
}

/** The handle itself, plus the pipe control. */
export interface OpenedStoreForTest extends OpenEpicStoreHandle {
  /** Deliver everything queued on the pipe, and everything that causes. */
  flush(): Promise<void>;
  /** The root replica's live doc and awareness, from the IN-PROCESS worker. */
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** The composed replica runtime itself, and the port the bridge reaches it by. */
  readonly runtime: EpicReplicaRuntime;
  readonly workerPort: RuntimeWorkerPort;
  /** How many times the store has asked its owner to rebuild the transport. */
  retryTransportRequests(): number;
}

export function openStoreForTest(
  options: OpenStoreForTestOptions,
): OpenedStoreForTest {
  // The worker side, in this thread: the real host with a real core, given the suite's factories in
  // place of the proxy-built ones.
  return openStoreOver(
    createInProcessEpicRuntimeWorker(options.factories),
    options,
    "sync",
  );
}

/**
 * The identical wiring over a QUEUED bridge, for suites that need to control interleaving rather
 * than have the pipe settle each call before the next.
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

  // The SAME helper the provider uses, not a copy of its wiring: the two held identical inline slots
  // before, which is how they would drift.
  const projection = createLateBoundProjectionTarget<
    Partial<EpicRuntimeProjection>
  >(
    (value) => (isProjectionPatch(value) ? value : null),
    () => {
      // A suite that cares asserts on the store; a pre-attach rejection here
      // is not something a test can act on.
    },
  );
  // Late-bound for the same reason `projectionTarget` is: the worker is spawned before the store
  // that owns the live body docs exists, so the return leg cannot be handed over at spawn time.
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
    // UNREACHABLE in this harness, and answered rather than defaulted so it stays that way.
    laneUnary: () =>
      Promise.resolve({
        ok: false,
        reason:
          "openStoreForTest composes the suite's own lane unaries; this bridge handler is not the path",
      }),
    streams: createRecordingStreamClient().client,
    // Nothing negotiated, which is what `"unknown"` means - and inert here for the same reason
    // `laneUnary` is: the composition reads the suite's `laneSelection.support`, not this.
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
    // The SAME host id the accounting port above is built with, not a second literal: the worker's
    // write-command queue reads this as its send gate, and a harness whose two halves named different
    hostId: "test-host",
    windowLabel: "test-window",
  });

  let retryTransportRequests = 0;
  const handle = createOpenEpicStore({
    epicId: options.epicId,
    userId: options.userId,
    // Not on `OpenStoreForTestOptions`: every other caller of this harness would need to start passing
    // it for no reason, since the one suite that cares about a specific `hostId` (the registry's
    hostId: "test-host",
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
    // The bootstrap is emitted synchronously by `spawnEpicRuntimeWorker` over a `"sync"` pipe, so this
    // is unreachable - and it is checked rather than asserted, because a harness that silently handed
    throw new Error("[openStoreForTest] the worker composed no runtime");
  }
  // The flip, and it lives HERE rather than in a suite: composition is done, so everything after
  // this is the behaviour under test.
  inProcessWorker.setDelivery(deliveryAfterComposition);
  return {
    ...handle,
    flush: () => inProcessWorker.flush(),
    get doc(): Y.Doc {
      return runtime.doc;
    },
    get awareness(): Awareness {
      return runtime.awareness;
    },
    // A plain value, not a getter, and the asymmetry with `doc`/`awareness` above is the point: those
    // two are REPLACED when the replica is (a viewer downgrade, a fresh snapshot), which is why they
    runtime,
    workerPort: worker.port,
    retryTransportRequests: () => retryTransportRequests,
  };
}
