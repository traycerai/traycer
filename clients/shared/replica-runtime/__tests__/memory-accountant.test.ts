/**
 * Behavioural coverage for `createMemoryAccountant`.
 *
 * The cases that a naive implementation is most likely to get wrong:
 * settle replaces rather than adds; reclaiming zero latches
 * `"over-protected"` and a second reconcile must NOT retry the hook;
 * pressure is computed from holders after the hook returns, not from the
 * hook's claimed `reclaimedBytes`.
 */
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironment } from "../runtime-environment";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
  type EvictionOutcome,
  type PlaneBudgetSpec,
} from "../memory-accountant";

function createFakeEnvironment(): RuntimeEnvironment & {
  advanceClock(ms: number): void;
} {
  let nowMs = 0;
  return {
    clock: {
      now(): number {
        return nowMs;
      },
    },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    advanceClock(ms: number): void {
      nowMs += ms;
    },
  };
}

function emptyOutcome(): EvictionOutcome {
  return { reclaimedBytes: 0, protectedBytesByKind: [] };
}

function spec(input: {
  readonly planeId: string;
  readonly softLimitBytes: number;
  readonly nearThresholdRatio: number;
  readonly evict: PlaneBudgetSpec["evict"];
}): PlaneBudgetSpec {
  return {
    planeId: input.planeId,
    softLimitBytes: input.softLimitBytes,
    nearThresholdRatio: input.nearThresholdRatio,
    evict: input.evict,
  };
}

describe("createMemoryAccountant", () => {
  it("reports under at zero and near when charged past the near threshold but not the limit", () => {
    const environment = createFakeEnvironment();
    const accountant = createMemoryAccountant({
      environment,
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: BUDGET_PLANE_IDS.chatWindows,
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );

    expect(accountant.pressure(BUDGET_PLANE_IDS.chatWindows)).toBe("under");
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "a", 80);
    expect(accountant.pressure(BUDGET_PLANE_IDS.chatWindows)).toBe("under");
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "a", 81);
    expect(accountant.pressure(BUDGET_PLANE_IDS.chatWindows)).toBe("near");
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "a", 100);
    expect(accountant.pressure(BUDGET_PLANE_IDS.chatWindows)).toBe("near");
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "a", 101);
    expect(accountant.pressure(BUDGET_PLANE_IDS.chatWindows)).toBe("over");
  });

  it("settle replaces the holder's total rather than adding to it", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 10_000,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    accountant.chargeProvisional("p", "h", 40);
    accountant.settle("p", "h", 25);
    const usage = accountant.snapshot().planes[0];
    expect(usage.settledBytes).toBe(25);
    expect(usage.provisionalBytes).toBe(0);
    expect(usage.holderCount).toBe(1);
    // A second settle of 25 is still 25, not 50.
    accountant.settle("p", "h", 25);
    expect(accountant.snapshot().planes[0].settledBytes).toBe(25);
  });

  it("chargeProvisional accumulates until settle replaces both sides", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 10_000,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    accountant.chargeProvisional("p", "h", 10);
    accountant.chargeProvisional("p", "h", 15);
    expect(accountant.snapshot().planes[0].provisionalBytes).toBe(25);
    expect(accountant.snapshot().planes[0].settledBytes).toBe(0);
    accountant.settle("p", "h", 7);
    expect(accountant.snapshot().planes[0].provisionalBytes).toBe(0);
    expect(accountant.snapshot().planes[0].settledBytes).toBe(7);
  });

  it("release forgets a holder so a leak is attributable by absence", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 10_000,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    accountant.settle("p", "h1", 10);
    accountant.settle("p", "h2", 20);
    accountant.release("p", "h1");
    const usage = accountant.snapshot().planes[0];
    expect(usage.holderCount).toBe(1);
    expect(usage.settledBytes).toBe(20);
  });

  it("reconcile asks the plane for overBytes and records the outcome", () => {
    const evict = vi.fn((): EvictionOutcome => {
      return {
        reclaimedBytes: 30,
        protectedBytesByKind: [{ kind: "visible", bytes: 80 }],
      };
    });
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict,
      }),
    );
    accountant.settle("p", "h", 150);
    // The hook is responsible for actually dropping data AND settling. This
    // test's hook claims 30 reclaimed but does not settle, so the holders
    // still read 150 and pressure latches over-protected.
    const pressure = accountant.reconcile("p");
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledWith(50);
    expect(pressure).toBe("over-protected");
    const usage = accountant.snapshot().planes[0];
    expect(usage.evictionsRequested).toBe(1);
    expect(usage.bytesReclaimed).toBe(30);
    expect(usage.evictionsRefused).toBe(0);
  });

  it("latches over-protected when the hook reclaims nothing, and does not retry", () => {
    const evict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 0,
      protectedBytesByKind: [{ kind: "tail", bytes: 200 }],
    }));
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict,
      }),
    );
    accountant.settle("p", "h", 200);
    expect(accountant.reconcile("p")).toBe("over-protected");
    expect(accountant.reconcile("p")).toBe("over-protected");
    expect(evict).toHaveBeenCalledTimes(1);
    expect(accountant.snapshot().planes[0].evictionsRefused).toBe(1);
  });

  it("clears the over-protected latch on settle so newly evictable bytes can be asked for", () => {
    const evict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 0,
      protectedBytesByKind: [{ kind: "leased", bytes: 200 }],
    }));
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict,
      }),
    );
    accountant.settle("p", "h", 200);
    accountant.reconcile("p");
    accountant.settle("p", "h", 200);
    expect(accountant.pressure("p")).toBe("over");
    accountant.reconcile("p");
    expect(evict).toHaveBeenCalledTimes(2);
  });

  it("treats a hook that settles holders under the limit as under, not over-protected", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict: () => {
          accountant.settle("p", "h", 40);
          return {
            reclaimedBytes: 80,
            protectedBytesByKind: [],
          };
        },
      }),
    );
    accountant.settle("p", "h", 120);
    expect(accountant.reconcile("p")).toBe("under");
    expect(accountant.snapshot().planes[0].settledBytes).toBe(40);
    expect(accountant.snapshot().planes[0].evictionsRefused).toBe(0);
  });

  it("stamps snapshot.takenAtMs from the injected clock", () => {
    const environment = createFakeEnvironment();
    const accountant = createMemoryAccountant({
      environment,
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    environment.advanceClock(42);
    expect(accountant.snapshot().takenAtMs).toBe(42);
  });

  it("sums charged bytes across planes in totalChargedBytes", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    accountant.register(
      spec({
        planeId: BUDGET_PLANE_IDS.chatWindows,
        softLimitBytes: 1000,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    accountant.register(
      spec({
        planeId: BUDGET_PLANE_IDS.hotDocs,
        softLimitBytes: 1000,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "c", 10);
    accountant.chargeProvisional(BUDGET_PLANE_IDS.hotDocs, "d", 7);
    expect(accountant.snapshot().totalChargedBytes).toBe(17);
  });

  it("unregistering a plane forgets every charge against it", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    const registration = accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    accountant.settle("p", "h", 50);
    registration.release();
    expect(accountant.snapshot().planes).toEqual([]);
    expect(() => accountant.pressure("p")).toThrow(/not registered/);
  });

  it("refuses a second register of the same planeId", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    const plane = spec({
      planeId: "p",
      softLimitBytes: 100,
      nearThresholdRatio: 0.8,
      evict: () => emptyOutcome(),
    });
    accountant.register(plane);
    expect(() => accountant.register(plane)).toThrow(/already registered/);
  });

  it("throws on charge or settle of an unregistered plane, and on negative bytes", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    expect(() => accountant.chargeProvisional("missing", "h", 1)).toThrow(
      /not registered/,
    );
    expect(() => accountant.settle("missing", "h", 1)).toThrow(
      /not registered/,
    );
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    expect(() => accountant.settle("p", "h", -1)).toThrow(/non-negative/);
    expect(() => accountant.chargeProvisional("p", "h", Number.NaN)).toThrow(
      /non-negative/,
    );
  });

  it("rejects a nearThresholdRatio outside (0, 1]", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    expect(() =>
      accountant.register(
        spec({
          planeId: "p",
          softLimitBytes: 100,
          nearThresholdRatio: 0,
          evict: () => emptyOutcome(),
        }),
      ),
    ).toThrow(/nearThresholdRatio/);
    expect(() =>
      accountant.register(
        spec({
          planeId: "q",
          softLimitBytes: 100,
          nearThresholdRatio: 1.1,
          evict: () => emptyOutcome(),
        }),
      ),
    ).toThrow(/nearThresholdRatio/);
  });

  it("release of an unknown holder or plane is a no-op", () => {
    const accountant = createMemoryAccountant({
      environment: createFakeEnvironment(),
      observedCeilingBytes: 1000,
    });
    expect(() => accountant.release("missing", "h")).not.toThrow();
    accountant.register(
      spec({
        planeId: "p",
        softLimitBytes: 100,
        nearThresholdRatio: 0.8,
        evict: () => emptyOutcome(),
      }),
    );
    expect(() => accountant.release("p", "nobody")).not.toThrow();
  });
});
