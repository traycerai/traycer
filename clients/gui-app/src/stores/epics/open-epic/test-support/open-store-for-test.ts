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
import { createFakeBridgePair } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { createFakeWorkerTarget } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-worker-target";
import { createRecordingStreamClient } from "@traycer-clients/shared/replica-runtime/worker/test-support/recording-stream-client";

import { createOpenEpicStore, type OpenEpicStoreHandle } from "../store";
import { createProcessBackedAccountingPort } from "../runtime/process-backed-accounting-port";
import { createRendererRuntimeEnvironment } from "../runtime/runtime-environment";
import { spawnEpicRuntimeWorker } from "../runtime/worker/spawn-epic-runtime-worker";
import { startEpicRuntimeWorkerHost } from "../runtime/worker/epic-runtime-worker-host";
import { installEpicRuntimeCore } from "../runtime/worker/install-epic-runtime-core";
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
}

export function openStoreForTest(
  options: OpenStoreForTestOptions,
): OpenedStoreForTest {
  const pair = createFakeBridgePair("sync");

  // The worker side, in this thread: the real host, given the suite's
  // factories in place of the proxy-built ones.
  const host = startEpicRuntimeWorkerHost(pair.worker);
  const composedRuntime = installEpicRuntimeCore(host, () => options.factories);

  const accounting = createProcessBackedAccountingPort({
    hostId: "test-host",
    epicId: options.epicId,
    environment: createRendererRuntimeEnvironment(),
  });

  let projectionTarget: OpenEpicStoreHandle["projection"] | null = null;
  // Late-bound for the same reason `projectionTarget` is: the worker is
  // spawned before the store that owns the live body docs exists, so the
  // return leg cannot be handed over at spawn time. Both latches close on the
  // next line after `createOpenEpicStore` returns.
  let bodyTarget: OpenEpicStoreHandle["body"] | null = null;
  const worker = spawnEpicRuntimeWorker<Partial<EpicRuntimeProjection>>({
    createWorker: () => ({
      ...createFakeWorkerTarget(pair),
      terminate: () => {
        pair.sever();
      },
    }),
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
    streams: createRecordingStreamClient().client,
    accounting,
    projection: {
      accept: (value) => projectionTarget?.accept(value) ?? null,
      apply: (value, revision) => {
        projectionTarget?.apply(value, revision);
      },
      reject: (reason, revision) => {
        projectionTarget?.reject(reason, revision);
      },
    },
    body: {
      applyDocUpdate: (docKey, update) => {
        bodyTarget?.applyDocUpdate(docKey, update);
      },
      applyAwareness: (docKey, frame) => {
        bodyTarget?.applyAwareness(docKey, frame);
      },
    },
    epicId: options.epicId,
    windowLabel: "test-window",
  });

  const handle = createOpenEpicStore({
    epicId: options.epicId,
    userId: options.userId,
    accounting,
    runtime: {
      port: worker.port,
      command: (command) => {
        worker.command(command);
      },
      awarenessOut: (docKey, frame, localClientId) => {
        worker.awarenessOut(docKey, frame, localClientId);
      },
      detach: () => {
        worker.detach();
      },
      dispose: () => {
        worker.dispose();
      },
    },
  });
  projectionTarget = handle.projection;
  bodyTarget = handle.body;

  const runtime = composedRuntime();
  if (runtime === null) {
    // The bootstrap is emitted synchronously by `spawnEpicRuntimeWorker` over
    // a `"sync"` pipe, so this is unreachable - and it is checked rather than
    // asserted, because a harness that silently handed back a doc-less handle
    // would fail somewhere far from the cause.
    throw new Error("[openStoreForTest] the worker composed no runtime");
  }
  return {
    ...handle,
    flush: () => pair.flush(),
    // GETTERS, not captured values. `epic-session-provider.tsx` states the
    // cost of getting this wrong: freezing them "leaves every consumer holding
    // a DESTROYED `Y.Doc` and `Awareness` while the live ones are unreachable"
    // - and a replica replacement (a viewer downgrade, a fresh snapshot, an
    // authority-epoch change) is exactly what these suites drive. The runtime
    // declares them as getters for this reason; re-declaring them here is what
    // carries that through the harness.
    get doc(): Y.Doc {
      return runtime.doc;
    },
    get awareness(): Awareness {
      return runtime.awareness;
    },
  };
}
