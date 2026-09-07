/** A runtime worker with a REAL core, on this thread. */
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

// Re-exported so the harness entry point can name the delivery mode without opening a second
// cross-package import edge for a type this module already carries.
export type { FakeBridgeDelivery };

export interface InProcessEpicRuntimeWorker {
  /** The factory to hand `spawnEpicRuntimeWorker` or `__setEpicRuntimeWorkerFactoryForTests`. */
  createWorker(): RuntimeWorkerLike;
  /** The composition this worker built, or `null` before its bootstrap lands. */
  composedRuntime(): EpicReplicaRuntime | null;
  /** Deliver everything queued on the pipe, and everything that causes. */
  flush(): Promise<void>;
  /**
   * Change delivery for every frame from here on. For `openStoreForTestWithQueuedBridge`, which
   * flips to `"queued"` once the runtime is composed.
   */
  setDelivery(next: FakeBridgeDelivery): void;
}

export function createInProcessEpicRuntimeWorker(
  factories: EpicRuntimeStreamFactories,
): InProcessEpicRuntimeWorker {
  return createInProcessWorker(() => factories);
}

/** The same in-process bridge, with the production worker's factory builder. */
export function createProxiedInProcessEpicRuntimeWorker(): InProcessEpicRuntimeWorker {
  return createInProcessWorker(buildProxiedRuntimeFactories);
}

function createInProcessWorker(
  buildFactories: (host: EpicRuntimeWorkerHost) => EpicRuntimeStreamFactories,
): InProcessEpicRuntimeWorker {
  // ALWAYS `"sync"` here: composition happens inside the caller's `spawnEpicRuntimeWorker`, over
  // this pipe, so a pair queued from birth cannot construct a runtime at all.
  const pair = createFakeBridgePair("sync");
  // The worker side, in this thread: the real host, given either production's proxy builder or the
  // caller's explicit factories through the one seam `epic-runtime-composition.ts` documents.
  const host = startEpicRuntimeWorkerHost(pair.worker);
  const composed = installEpicRuntimeCore(host, buildFactories);
  return {
    createWorker: () => ({
      ...createFakeWorkerTarget(pair),
      terminate: () => {
        pair.sever();
      },
      // Unreachable here, and stated rather than left to a default: the host this pair reaches runs in
      // THIS thread, so there is no module fetch to fail and no DOM event to report one.
      onWorkerFault: () => {},
    }),
    composedRuntime: () => composed(),
    flush: () => pair.flush(),
    setDelivery: (next) => {
      pair.setDelivery(next);
    },
  };
}
