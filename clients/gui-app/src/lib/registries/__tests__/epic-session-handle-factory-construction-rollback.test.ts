/**
 * Pins the construction-rollback span in `createEpicSessionHandle`
 * (`epic-session-handle-factory.ts`'s `try { ... } catch (error: unknown) { ... }`):
 * once the runtime worker spawn has succeeded, a LATER throw inside the same
 * `try` (here, store construction) must still leave the run clean - the
 * spawned worker disposed exactly once, the transport this construction
 * opened closed with a `construction-failed` reason, and the original error
 * propagating unchanged. A regression here leaks a live worker thread and a
 * dialling socket for the life of the window; see the factory's own comment
 * on the `try` span for why the rollback covers the whole window rather than
 * one call inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Counts real `dispose()` calls on the runtime worker handle this run spawns.
 * A `vi.hoisted` cell rather than a module-level `let`: the `vi.mock` factory
 * below runs hoisted, above this file's other declarations, so it cannot
 * close over a plain variable declared after it - both the factory and the
 * test body have to reach the same cell through this.
 */
const disposeTracking = vi.hoisted((): { count: number } => ({ count: 0 }));

/**
 * Pass-through spy on `spawnEpicRuntimeWorker`: the REAL spawn still runs
 * underneath - a stubbed handle would let the rollback's own `dispose()` call
 * no-op the exact behaviour this suite pins - and only the returned handle's
 * `dispose` is wrapped to count calls. Mirrors the `spawnedRuntimeOptions`
 * pass-through idiom in `providers/__tests__/epic-session-provider.test.tsx`.
 */
vi.mock(
  "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker")
      >();
    return {
      ...actual,
      spawnEpicRuntimeWorker: (
        options: Parameters<typeof actual.spawnEpicRuntimeWorker>[0],
      ) => {
        const handle = actual.spawnEpicRuntimeWorker(options);
        return {
          ...handle,
          dispose: (): void => {
            disposeTracking.count += 1;
            handle.dispose();
          },
        };
      },
    };
  },
);

/**
 * The sentinel `createOpenEpicStore` throws below, and the exact value this
 * suite asserts propagates out of `createEpicSessionHandle` unchanged - an
 * identity check, not a message match, so a rollback that wraps or rebuilds
 * the error would still be caught.
 */
const storeConstructionFailure = vi.hoisted(
  (): Error => new Error("store construction sentinel failure"),
);

/**
 * Only `createOpenEpicStore` is replaced. Every other export stays real:
 * `isProjectionPatch` and the `OpenEpicState` / `OpenEpicStoreHandle` types
 * are imported by the factory from this same module, and a mock that dropped
 * them would break the factory's own imports instead of exercising the
 * rollback this suite is about.
 */
vi.mock("@/stores/epics/open-epic/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/epics/open-epic/store")>();
  return {
    ...actual,
    createOpenEpicStore: (): never => {
      throw storeConstructionFailure;
    },
  };
});

import {
  createEpicSessionHandle,
  type EpicSessionHandleSpec,
  type EpicSessionRequesterTarget,
} from "@/lib/registries/epic-session-handle-factory";
import {
  fakeDurableStreamTransports,
  resetFakeDurableStreamTransports,
} from "@/lib/host/test-support/fake-durable-stream-transport";
import { __setEpicRuntimeWorkerFactoryForTests } from "@/lib/registries/epic-runtime-worker-factory-slot";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";

/**
 * Inert `RuntimeWorkerLike`: never delivers a message, never faults, never
 * throws. jsdom has no `Worker`, so this is the seam the real
 * `spawnEpicRuntimeWorker` needs in order to return a real handle
 * synchronously - this suite is about what happens to that handle AFTER it
 * exists, not about anything the worker itself reports.
 */
function createInertRuntimeWorker(): RuntimeWorkerLike {
  return {
    postMessage: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    terminate: () => undefined,
    onWorkerFault: () => undefined,
  };
}

/**
 * A requester target with nobody pointed anywhere. Nothing in this run ever
 * dispatches a write command or a lane unary - the throw happens before the
 * store (and therefore before any caller of the factory's own
 * `requesterForHandleHost`) exists - so every field can be the "no session,
 * no target" answer.
 */
function unresolvedRequesterTarget(): EpicSessionRequesterTarget {
  return {
    targetHostId: null,
    targetHostClient: null,
    sessionHostId: null,
    sessionHostClient: null,
  };
}

function buildSpec(): EpicSessionHandleSpec {
  return {
    epicId: "epic-construction-rollback",
    hostId: "host-construction-rollback",
    // `null` so the factory skips `adoptLegacyPersistKey` entirely - this
    // suite is not about the legacy-persist-bucket adoption path.
    userId: null,
    openTransport: fakeDurableStreamTransports().opener,
    readRequesterTarget: unresolvedRequesterTarget,
    onAuthError: () => undefined,
    adoptLegacyPersistKey: () => undefined,
    onPlanRestrictedDenial: () => undefined,
    markHealthy: () => undefined,
    onRuntimeFatal: () => undefined,
    onRetryTransport: () => undefined,
  };
}

describe("createEpicSessionHandle construction rollback", () => {
  beforeEach(() => {
    resetFakeDurableStreamTransports();
    __setEpicRuntimeWorkerFactoryForTests(createInertRuntimeWorker);
    disposeTracking.count = 0;
  });

  afterEach(() => {
    __setEpicRuntimeWorkerFactoryForTests(null);
  });

  it("disposes the spawned worker exactly once, closes the transport as construction-failed, and rethrows the original error", () => {
    const spec = buildSpec();

    let thrown: unknown;
    try {
      createEpicSessionHandle(spec);
    } catch (error: unknown) {
      thrown = error;
    }

    // The exact thrown VALUE, not a message match.
    expect(thrown).toBe(storeConstructionFailure);

    expect(disposeTracking.count).toBe(1);

    // ONE transport, and it was closed once with the rollback's own reason.
    // The length assertion is half the claim: a rollback that reopened rather
    // than closed would satisfy the reason check on a second record.
    const records = fakeDurableStreamTransports().records;
    expect(records).toHaveLength(1);
    expect(records[0].closeReasons).toEqual([
      "durable-transport-closed:construction-failed",
    ]);
  });
});
