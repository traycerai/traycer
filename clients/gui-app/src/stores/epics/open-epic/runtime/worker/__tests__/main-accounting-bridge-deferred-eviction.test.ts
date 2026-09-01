/**
 * `createMainAccountingBridge`'s `demoteColdestUnpinned` proxy
 * (`main-accounting-bridge.ts:83-93`) dispatches the demote and answers
 * `reclaimedBytes: 0` - a DEFERRED eviction, not a refused one. But it never
 * tells the accountant that: the split counter
 * (`deferred-eviction-contract.test.ts`) shows the accountant only counts a
 * deferral when the tier itself calls `MemoryAccountant.noteEvictionDeferred`
 * during the evict call, and this proxy never does. So every breach the
 * bridge defers is counted as a REFUSAL, which is wrong on its own terms and
 * also poisons the telemetry surface a memory-pressure affordance would read.
 *
 * Post-fix, the proxy calls `options.port.noteHotDocEvictionDeferred()`
 * immediately before `options.dispatchDemote(overBytes)`. That member does
 * not exist on `EpicRuntimeAccountingPort` yet, so the test double below adds
 * it as an extra property - safe at runtime, and accepted by the type system
 * because an object satisfying a wider shape is assignable to the narrower
 * parameter type.
 *
 * Built directly against `createMainAccountingBridge` with a REAL
 * `MemoryAccountant` and a real `HotDocBudgetBook` - not the in-process
 * worker's "sync" test harness, whose demote is served re-entrantly inside
 * the same `evict` call and would make this pin pass identically before and
 * after the fix.
 */
import { describe, expect, it } from "vitest";
import type {
  MemoryAccountant,
  ProtectedBytes,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
} from "@traycer-clients/shared/replica-runtime";
import type { HotDocBudgetBook } from "@/stores/replica-memory/hot-doc-budget";
import {
  createHotDocBudgetBook,
  hotDocHolderId,
} from "@/stores/replica-memory/hot-doc-budget";
import { createMainAccountingBridge } from "../main-accounting-bridge";
import type {
  EpicRuntimeAccountingPort,
  EpicRuntimeAccountingSource,
} from "../../epic-runtime-accounting-port";
import type { HotDocEvictionOutcome } from "../../epic-runtime-accounting-port";

const SOFT_LIMIT_BYTES = 1_000;

/** What the worker-side tier reports it could not free. */
const PROTECTED: readonly ProtectedBytes[] = [{ kind: "leased", bytes: 4_096 }];

function environmentStub(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  };
}

/**
 * A minimal, REAL `EpicRuntimeAccountingPort`: `registerBooks` attaches the
 * given source straight into a real `HotDocBudgetBook`, and `settleHotDocBytes`
 * settles into a real `MemoryAccountant` and reconciles - exactly what
 * `process-backed-accounting-port.ts` does, minus the host/epic identity
 * plumbing this pin has no need of.
 *
 * `noteHotDocEvictionDeferred` is the member this pin exists for: the bridge
 * raises it from inside its `evict` closure, and this port answers by raising
 * the accountant's own flag - which is what makes the zero return readable as
 * a deferral rather than a refusal.
 */
function createTestPort(
  book: HotDocBudgetBook,
  accountant: MemoryAccountant,
): EpicRuntimeAccountingPort {
  let source: EpicRuntimeAccountingSource | null = null;
  return {
    registerBooks(next): void {
      source = next;
      book.attach({
        key: "book-1",
        materializedIds: () => source?.materializedRoomIds() ?? [],
        demoteColdestUnpinned: (overBytes): HotDocEvictionOutcome =>
          source?.demoteColdestUnpinned(overBytes) ?? {
            reclaimedBytes: 0,
            deferredBytes: 0,
            protectedBytesByKind: [],
          },
      });
    },
    unregisterBooks(): void {
      source = null;
      book.detach("book-1");
    },
    settleRootBytes(): void {},
    settleColdRoomBytes(): void {},
    settleCommandOverlayBytes(): void {},
    settleHotDocBytes(artifactRoomId, bytes): void {
      book.settle(
        accountant,
        hotDocHolderId("host-1", "epic-1", "token-1", artifactRoomId),
        bytes,
      );
      accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);
    },
    chargeHotDocProvisional(): void {},
    releaseHotDoc(): void {},
    noteHotDocEvictionDeferred(): void {
      accountant.noteEvictionDeferred(BUDGET_PLANE_IDS.hotDocs);
    },
  };
}

describe("createMainAccountingBridge's demote proxy", () => {
  it("THE REDDENING ONE - a breach it defers must count as deferred, not refused", () => {
    const book = createHotDocBudgetBook();
    const accountant = createMemoryAccountant({
      environment: environmentStub(),
      observedCeilingBytes: 100_000,
    });
    accountant.register({
      planeId: BUDGET_PLANE_IDS.hotDocs,
      softLimitBytes: SOFT_LIMIT_BYTES,
      nearThresholdRatio: 0.8,
      evict: (overBytes) => book.evict(overBytes),
    });
    const port = createTestPort(book, accountant);
    const dispatched: number[] = [];
    const bridge = createMainAccountingBridge({
      port,
      dispatchDemote: (overBytes) => {
        dispatched.push(overBytes);
      },
    });

    bridge.handle({
      kind: "accounting/books",
      registered: true,
      snapshot: {
        materializedRoomIds: [],
        rootBytes: 0,
        protectedBytesByKind: PROTECTED,
        projectionCounts: null,
      },
    });
    bridge.handle({
      kind: "accounting/settle",
      settlement: {
        kind: "hot-doc",
        artifactRoomId: "room-1",
        bytes: SOFT_LIMIT_BYTES * 2,
      },
      snapshot: {
        materializedRoomIds: [],
        rootBytes: 0,
        protectedBytesByKind: PROTECTED,
        projectionCounts: null,
      },
    });

    // The demote really was dispatched - this pin is about how it is COUNTED,
    // not about whether it happened at all.
    expect(dispatched.length).toBeGreaterThan(0);

    const plane = accountant
      .snapshot()
      .planes.find((usage) => usage.planeId === BUDGET_PLANE_IDS.hotDocs);
    // Red today as `evictionsDeferred: 0, evictionsRefused: 1` - the proxy
    // never calls `noteHotDocEvictionDeferred`, so the accountant has no way
    // to tell this apart from a tier that genuinely declined.
    expect(plane?.evictionsDeferred).toBe(1);
    expect(plane?.evictionsRefused).toBe(0);
  });

  it("CONTROL - a tier that genuinely declines is still counted as refused", () => {
    const book = createHotDocBudgetBook();
    const accountant = createMemoryAccountant({
      environment: environmentStub(),
      observedCeilingBytes: 100_000,
    });
    accountant.register({
      planeId: BUDGET_PLANE_IDS.hotDocs,
      softLimitBytes: SOFT_LIMIT_BYTES,
      nearThresholdRatio: 0.8,
      evict: (overBytes) => book.evict(overBytes),
    });
    // No bridge at all here - a tier attached directly, answering the same
    // zero-reclaim shape the proxy does, but never calling
    // `noteEvictionDeferred`. Keeps pin 1 honest: without this, "deferred is
    // always 1" could be satisfied by a bridge that always reports deferred.
    book.attach({
      key: "book-1",
      materializedIds: () => [],
      demoteColdestUnpinned: (): HotDocEvictionOutcome => ({
        reclaimedBytes: 0,
        deferredBytes: 0,
        protectedBytesByKind: PROTECTED,
      }),
    });

    book.settle(
      accountant,
      hotDocHolderId("host-1", "epic-1", "token-1", "room-1"),
      SOFT_LIMIT_BYTES * 2,
    );
    accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);

    const plane = accountant
      .snapshot()
      .planes.find((usage) => usage.planeId === BUDGET_PLANE_IDS.hotDocs);
    expect(plane?.evictionsRefused).toBe(1);
    expect(plane?.evictionsDeferred).toBe(0);
  });
});
