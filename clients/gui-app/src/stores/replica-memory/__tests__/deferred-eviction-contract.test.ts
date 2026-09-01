/**
 * The two facts 4e's deferred-eviction proxy rests on.
 *
 * At the flip the accountant stays on MAIN and the artifact-room tier moves
 * into the worker, so `tier.demoteColdestUnpinned(overBytes)` — which today is
 * called synchronously mid-reconcile and whose return decrements a running
 * total — becomes a call that cannot be made. The proxy answers
 * `reclaimedBytes: 0`, dispatches an evict request, and the worker's settles
 * reconcile when they arrive.
 *
 * That is only safe because of the two properties pinned here. Both are
 * properties of code 4e does NOT change, which is exactly why they need pins:
 * nothing else would notice them being broken, and the failure would present
 * as a memory leak or a hang rather than as a test.
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
import {
  createHotDocBudgetBook,
  hotDocHolderId,
} from "@/stores/replica-memory/hot-doc-budget";
import type { HotDocEvictionOutcome } from "@/stores/epics/open-epic/runtime/epic-runtime-accounting-port";

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
 * A tier standing in for the post-flip proxy: it frees nothing and reports why.
 * `calls` is the whole point of pin 1.
 */
function deferringTier(
  protectedBytes: readonly ProtectedBytes[],
  dispatchTo: MemoryAccountant | null,
  // Distinct per tier so several epics' tiers can be attached at once - the
  // book keys its map on this, so a shared key would silently collapse them
  // into one and make a multi-epic pin unable to fail.
  key: string,
): {
  readonly key: string;
  materializedIds(): readonly string[];
  demoteColdestUnpinned(overBytes: number): HotDocEvictionOutcome;
  readonly calls: number[];
} {
  const calls: number[] = [];
  return {
    key,
    calls,
    materializedIds: () => [],
    demoteColdestUnpinned(overBytes): HotDocEvictionOutcome {
      calls.push(overBytes);
      // What the post-flip proxy does: hand the work to the worker and SAY SO,
      // from inside the evict call, so the reconcile that asked can tell this
      // apart from a tier that declined.
      dispatchTo?.noteEvictionDeferred(BUDGET_PLANE_IDS.hotDocs);
      // Exactly the proxy's answer: nothing freed HERE, because the freeing
      // happens in the worker after this returns.
      // The SAME two facts the real proxy reports: nothing freed here, and
      // the whole ask accepted for the worker to free. Modelling only the
      // zero is what let the book double-count the ask across epics.
      return {
        reclaimedBytes: 0,
        deferredBytes: overBytes,
        protectedBytesByKind: protectedBytes,
      };
    },
  };
}

describe("a tier that frees nothing", () => {
  it("is asked EXACTLY once per evict - `evict` is a single pass, not a retry loop", () => {
    const book = createHotDocBudgetBook();
    const tier = deferringTier(PROTECTED, null, "book-1");
    book.attach(tier);

    const outcome = book.evict(10_000);

    // The load-bearing assertion. `evict` iterates `tiers.values()` once, so a
    // tier contributing zero simply advances the iteration - identical to a
    // tier whose every doc is pinned. If anyone turns this into "retry until
    // `remaining` is satisfied", a deferring proxy spins forever inside a
    // synchronous reconcile and the renderer wedges with no error to read.
    expect(tier.calls).toEqual([10_000]);
    expect(outcome.reclaimedBytes).toBe(0);
  });
});

describe("the protected breakdown a deferring tier reports", () => {
  it("reaches the accountant's snapshot, which is its only observer", () => {
    // NOT the `protectedLatch`, which was the expected observer and is not one:
    // `reconcile` sets the latch from `stillOver` alone (`memory-accountant.ts`
    // :446) and never reads `protectedBytesByKind`. The list is written to
    // `lastProtectedBytesByKind` and read back only by `usageOf` into
    // `snapshot()`. Asserting on the latch would have passed with the list
    // emptied, which is the whole failure mode this pin exists to catch.
    const book = createHotDocBudgetBook();
    book.attach(deferringTier(PROTECTED, null, "book-1"));
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

    book.settle(
      accountant,
      hotDocHolderId("host-1", "epic-1", "token-1", "room-1"),
      SOFT_LIMIT_BYTES * 2,
    );
    accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);

    const plane = accountant
      .snapshot()
      .planes.find((usage) => usage.planeId === BUDGET_PLANE_IDS.hotDocs);
    expect(plane?.protectedBytesByKind).toEqual(PROTECTED);
  });

  it("is what distinguishes `everything is pinned` from `there was nothing to free`", () => {
    // The two answers share `reclaimedBytes: 0` and differ only here, so a
    // proxy that reports `[]` while the worker's tier is full of leased docs
    // tells the accountant the plane is over its limit for no reason at all.
    const book = createHotDocBudgetBook();
    book.attach(deferringTier([], null, "book-1"));
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

    book.settle(
      accountant,
      hotDocHolderId("host-1", "epic-1", "token-1", "room-1"),
      SOFT_LIMIT_BYTES * 2,
    );
    accountant.reconcile(BUDGET_PLANE_IDS.hotDocs);

    const plane = accountant
      .snapshot()
      .planes.find((usage) => usage.planeId === BUDGET_PLANE_IDS.hotDocs);
    expect(plane?.protectedBytesByKind).toEqual([]);
  });
});

describe("the split counter", () => {
  it("counts a DISPATCHED eviction as deferred and not as refused", () => {
    // Before the split both cases incremented `evictionsRefused`, so a plane
    // whose tier is off-thread trended as "refusing" every breach it in fact
    // resolved. The two are mutually exclusive by construction: one breach
    // increments exactly one.
    const book = createHotDocBudgetBook();
    const accountant = createMemoryAccountant({
      environment: environmentStub(),
      observedCeilingBytes: 100_000,
    });
    book.attach(deferringTier(PROTECTED, accountant, "book-1"));
    accountant.register({
      planeId: BUDGET_PLANE_IDS.hotDocs,
      softLimitBytes: SOFT_LIMIT_BYTES,
      nearThresholdRatio: 0.8,
      evict: (overBytes) => book.evict(overBytes),
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
    expect(plane?.evictionsDeferred).toBe(1);
    expect(plane?.evictionsRefused).toBe(0);
  });

  it("counts a tier that genuinely declined as refused and not as deferred", () => {
    // The same zero bytes and the same protected list - the ONLY difference is
    // that nothing was dispatched. If these two ever report identically, the
    // split has silently collapsed back into one counter.
    const book = createHotDocBudgetBook();
    const accountant = createMemoryAccountant({
      environment: environmentStub(),
      observedCeilingBytes: 100_000,
    });
    book.attach(deferringTier(PROTECTED, null, "book-1"));
    accountant.register({
      planeId: BUDGET_PLANE_IDS.hotDocs,
      softLimitBytes: SOFT_LIMIT_BYTES,
      nearThresholdRatio: 0.8,
      evict: (overBytes) => book.evict(overBytes),
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

describe("several epics' tiers, all deferring", () => {
  it("does not hand the SAME overage to every one of them", () => {
    // A worker-backed tier answers `reclaimedBytes: 0` for a demotion it has
    // accepted and dispatched. Subtracting only what was reclaimed left the
    // running total untouched, so each epic in turn was asked for the whole
    // overage: five open epics turned a 1 MiB overage into 5 MiB of dispatched
    // demotion, evicting warm documents nothing needed and paying to re-encode
    // and rematerialize them on next use.
    const book = createHotDocBudgetBook();
    const first = deferringTier(PROTECTED, null, "book-1");
    const second = deferringTier(PROTECTED, null, "book-2");
    const third = deferringTier(PROTECTED, null, "book-3");
    book.attach(first);
    book.attach(second);
    book.attach(third);

    book.evict(10_000);

    // THE REDDENING ASSERTION. Previously every tier saw `[10_000]`.
    const asked = [first.calls, second.calls, third.calls];
    expect(asked.filter((calls) => calls.length > 0)).toHaveLength(1);
    expect(asked.flat()).toEqual([10_000]);
  });

  it("still reports ZERO reclaimed - a deferral is a promise, not a recovery", () => {
    // The control that keeps the fix from being "subtract it and call it
    // freed". The accountant decides whether the plane is still over from
    // `reclaimedBytes`; counting dispatched-but-unfreed bytes there would make
    // it stop asking on the strength of memory that is still resident.
    const book = createHotDocBudgetBook();
    book.attach(deferringTier(PROTECTED, null, "book-1"));
    book.attach(deferringTier(PROTECTED, null, "book-2"));

    expect(book.evict(10_000).reclaimedBytes).toBe(0);
  });

  it("rotates which tier is asked first, so a pinned epic cannot starve the others", () => {
    // The half that makes the fix net-correct rather than a trade. Bounding
    // the ask means one tier can absorb the whole overage; with a fixed
    // insertion-ordered walk that would always be the SAME tier, so an epic
    // whose documents are all pinned would answer every pass, free nothing,
    // and the epics holding genuinely cold documents would never be reached -
    // the plane over budget forever. That is worse than the over-eviction:
    // one wastes work, the other stops reclaiming.
    const book = createHotDocBudgetBook();
    const first = deferringTier(PROTECTED, null, "book-1");
    const second = deferringTier(PROTECTED, null, "book-2");
    book.attach(first);
    book.attach(second);

    book.evict(10_000);
    book.evict(10_000);
    book.evict(10_000);

    // Each pass reaches exactly one tier, and the turns alternate rather than
    // landing on the same one three times.
    expect(first.calls).toEqual([10_000, 10_000]);
    expect(second.calls).toEqual([10_000]);
  });
});
