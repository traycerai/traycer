/**
 * `createMainAccountingBridge`'s `demoteColdestUnpinned` proxy (`main-accounting-bridge.ts:83-93`)
 * dispatches the demote and answers `reclaimedBytes: 0` - a DEFERRED eviction, not a refused one.
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
 * A minimal, REAL `EpicRuntimeAccountingPort`: `registerBooks` attaches the given source straight
 * into a real `HotDocBudgetBook`, and `settleHotDocBytes` settles into a real `MemoryAccountant`
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
    // Red today as `evictionsDeferred: 0, evictionsRefused: 1` - the proxy never calls
    // `noteHotDocEvictionDeferred`, so the accountant has no way to tell this apart from a tier that
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
    // No bridge at all here - a tier attached directly, answering the same zero-reclaim shape the
    // proxy does, but never calling `noteEvictionDeferred`.
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

  it("stops deferring while its last demote is unanswered, so a later pass gets PAST it", () => {
    // A deferral is a promise, and a tier holding only pinned documents cannot keep it:
    // `worker-accounting-port`'s `demote` emits no settlement of its own, so a demotion that frees
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

    const snapshot = {
      materializedRoomIds: [],
      rootBytes: 0,
      protectedBytesByKind: PROTECTED,
      projectionCounts: null,
    };
    // ORDER MATTERS, and only because the walk rotates: the bridge's tier is registered first so it
    // sits at index 0 and pass 1 starts on it.
    bridge.handle({
      kind: "accounting/books",
      registered: true,
      snapshot,
    });

    // The SECOND tier - a plain in-process one, reached only when something
    // leaves part of the ask unclaimed.
    const coldAsks: number[] = [];
    book.attach({
      key: "book-cold",
      materializedIds: () => [],
      demoteColdestUnpinned: (overBytes): HotDocEvictionOutcome => {
        coldAsks.push(overBytes);
        return {
          reclaimedBytes: 0,
          deferredBytes: 0,
          protectedBytesByKind: [],
        };
      },
    });

    // Pass 1, starting at the bridge's tier. It defers the whole ask and the
    // walk ends there - correct, the promise has not been broken yet.
    bridge.handle({
      kind: "accounting/settle",
      settlement: {
        kind: "hot-doc",
        artifactRoomId: "room-1",
        bytes: SOFT_LIMIT_BYTES * 2,
      },
      snapshot,
    });
    expect(dispatched.length).toBe(1);
    expect(coldAsks.length).toBe(0);

    // Passes 2 and 3, driven WITHOUT any settlement from the deferring runtime
    port.settleHotDocBytes("room-2", SOFT_LIMIT_BYTES * 2);
    port.settleHotDocBytes("room-3", SOFT_LIMIT_BYTES * 2);

    // THE REDDENING ASSERTIONS. Two asks, not one: pass 2 started at the cold tier (rotation), and
    // pass 3 started at the bridge's tier and got PAST it.
    expect(coldAsks.length).toBe(2);
    // And exactly one demotion was ever dispatched. Before the fix this is 3: one per pass that
    // reached the tier, each into a runtime that had answered none of the previous ones.
    expect(dispatched.length).toBe(1);
  });

  it("re-arms on any settlement from its runtime, not only on the demotion's own", () => {
    // The control for the clause above.
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

    const snapshot = {
      materializedRoomIds: [],
      rootBytes: 0,
      protectedBytesByKind: PROTECTED,
      projectionCounts: null,
    };
    bridge.handle({ kind: "accounting/books", registered: true, snapshot });
    bridge.handle({
      kind: "accounting/settle",
      settlement: {
        kind: "hot-doc",
        artifactRoomId: "room-1",
        bytes: SOFT_LIMIT_BYTES * 2,
      },
      snapshot,
    });
    expect(dispatched.length).toBe(1);

    // A settlement arrives from this runtime - here a release, which is what a demotion that DID free
    // something produces.
    bridge.handle({
      kind: "accounting/settle",
      settlement: { kind: "hot-doc-release", artifactRoomId: "room-1" },
      snapshot,
    });
    port.settleHotDocBytes("room-3", SOFT_LIMIT_BYTES * 2);

    expect(dispatched.length).toBe(2);
  });
});
