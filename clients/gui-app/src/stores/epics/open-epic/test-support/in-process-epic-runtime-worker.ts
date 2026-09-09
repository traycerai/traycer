/**
 * A runtime worker with a REAL core, on this thread.
 *
 * The setup file (`__tests__/test-browser-apis.ts`) installs a **coreless**
 * worker for every jsdom suite: a real host over a fake pair, with no
 * composition behind it, answering "not held" to everything. That is the right
 * default - a suite that merely mounts a session must not be handed a live
 * replica it did not ask for.
 *
 * This is what a suite that DOES want one installs instead. It is the same
 * construction `openStoreForTest` has always used, extracted so the two cannot
 * drift: that harness is now a consumer of this helper rather than a second
 * copy of it. The provider suites reach it through
 * `__setEpicRuntimeWorkerFactoryForTests`, which is the seam that survived the
 * relocation - the stream-factory override did not, because a factory built on
 * MAIN cannot cross `postMessage` to a runtime that lives in the worker.
 *
 * One bridge harness, two explicit composition modes, no second wiring. The rule
 * `open-store-for-test.ts`'s header states - "a second wiring is a second
 * harness to keep honest, and the two would drift in exactly the places that
 * matter" - is why this file exists rather than a copy in the provider suite.
 */
import { createFakeBridgePair } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import type { FakeBridgeDelivery } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { createFakeWorkerTarget } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-worker-target";
import type { RuntimeWorkerLike } from "../runtime/worker/spawn-epic-runtime-worker";
import {
  startEpicRuntimeWorkerHost,
  type EpicRuntimeWorkerHost,
} from "../runtime/worker/epic-runtime-worker-host";
import {
  buildProxiedRuntimeFactories,
  installEpicRuntimeCore,
} from "../runtime/worker/install-epic-runtime-core";
import type { EpicRuntimeStreamFactories } from "../runtime/worker/epic-runtime-composition";
import type { EpicReplicaRuntime } from "../runtime/epic-replica-runtime";

// Re-exported so the harness entry point can name the delivery mode without
// opening a second cross-package import edge for a type this module already
// carries.
export type { FakeBridgeDelivery };

export interface InProcessEpicRuntimeWorker {
  /**
   * The factory to hand `spawnEpicRuntimeWorker` or
   * `__setEpicRuntimeWorkerFactoryForTests`.
   *
   * Terminating it SEVERS the pipe rather than shutting the host down, which
   * is the behaviour a spawned worker's `terminate()` has: main stops hearing
   * from a worker it has released, and anything still in flight is dropped
   * rather than answered.
   */
  createWorker(): RuntimeWorkerLike;
  /**
   * The composition this worker built, or `null` before its bootstrap lands.
   *
   * A GETTER, because the composition does not exist until the spawn emits the
   * bootstrap - which happens inside the caller's `spawnEpicRuntimeWorker`,
   * after this helper has returned.
   */
  composedRuntime(): EpicReplicaRuntime | null;
  /** Deliver everything queued on the pipe, and everything that causes. */
  flush(): Promise<void>;
  /**
   * Change delivery for every frame from here on.
   *
   * For `openStoreForTestWithQueuedBridge`, which flips to `"queued"` once the
   * runtime is composed. See `FakeBridgePair.setDelivery` for why it cannot
   * simply be constructed that way.
   */
  setDelivery(next: FakeBridgeDelivery): void;
}

export function createInProcessEpicRuntimeWorker(
  factories: EpicRuntimeStreamFactories,
): InProcessEpicRuntimeWorker {
  return createInProcessWorker(() => factories);
}

/**
 * The same in-process bridge, with the production worker's factory builder.
 *
 * Provider tests use this entry point when their claim begins at negotiated
 * method support: the main-side spawner emits `stream/manifest`,
 * {@link buildProxiedRuntimeFactories} reads that replicated manifest, and the
 * runtime selects its arm from the resulting live support source. Supplying a
 * pre-composed `laneSelection` here would bypass the very bootstrap path those
 * tests exist to cover.
 */
export function createProxiedInProcessEpicRuntimeWorker(): InProcessEpicRuntimeWorker {
  return createInProcessWorker(buildProxiedRuntimeFactories);
}

function createInProcessWorker(
  buildFactories: (host: EpicRuntimeWorkerHost) => EpicRuntimeStreamFactories,
): InProcessEpicRuntimeWorker {
  // ALWAYS `"sync"` here: composition happens inside the caller's
  // `spawnEpicRuntimeWorker`, over this pipe, so a pair queued from birth
  // cannot construct a runtime at all. A suite that needs queued delivery gets
  // it by flipping AFTER composition - see `setDelivery`.
  const pair = createFakeBridgePair("sync");
  // The worker side, in this thread: the real host, given either production's
  // proxy builder or the caller's explicit factories through the one seam
  // `epic-runtime-composition.ts` documents.
  const host = startEpicRuntimeWorkerHost(pair.worker);
  const composed = installEpicRuntimeCore(host, buildFactories);
  return {
    createWorker: () => ({
      ...createFakeWorkerTarget(pair),
      terminate: () => {
        pair.sever();
      },
      // Unreachable here, and stated rather than left to a default: the host
      // this pair reaches runs in THIS thread, so there is no module fetch to
      // fail and no DOM event to report one. The real `Worker` is the only
      // implementor that can ever call this listener.
      onWorkerFault: () => {},
    }),
    composedRuntime: () => composed(),
    flush: () => pair.flush(),
    setDelivery: (next) => {
      pair.setDelivery(next);
    },
  };
}
