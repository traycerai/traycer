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
  EvictionOutcome,
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

const SOFT_LIMIT_BYTES = 1_000;

/** What the worker-side tier reports it could not free. */
const PROTECTED: readonly ProtectedBytes[] = [{ kind: "leased", bytes: 4_096 }];

function environmentStub(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    timer: {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
    },
  };
}

/**
 * A tier standing in for the post-flip proxy: it frees nothing and reports why.
 * `calls` is the whole point of pin 1.
 */
function deferringTier(protectedBytes: readonly ProtectedBytes[]): {
  readonly key: string;
  materializedIds(): readonly string[];
  demoteColdestUnpinned(overBytes: number): EvictionOutcome;
  readonly calls: number[];
} {
  const calls: number[] = [];
  return {
    key: "book-1",
    calls,
    materializedIds: () => [],
    demoteColdestUnpinned(overBytes): EvictionOutcome {
      calls.push(overBytes);
      // Exactly the proxy's answer: nothing freed HERE, because the freeing
      // happens in the worker after this returns.
      return { reclaimedBytes: 0, protectedBytesByKind: protectedBytes };
    },
  };
}

describe("a tier that frees nothing", () => {
  it("is asked EXACTLY once per evict - `evict` is a single pass, not a retry loop", () => {
    const book = createHotDocBudgetBook();
    const tier = deferringTier(PROTECTED);
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
    book.attach(deferringTier(PROTECTED));
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
    book.attach(deferringTier([]));
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
