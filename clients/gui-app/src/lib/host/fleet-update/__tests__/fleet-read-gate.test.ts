import { afterEach, describe, expect, it } from "vitest";
import {
  resetFleetReadGateForTest,
  runWithFleetReadSlot,
} from "@/lib/host/fleet-update/fleet-read-gate";
import { FLEET_MAX_CONCURRENT_READS } from "@/lib/host/fleet-update/fleet-poll-policy";

// G3(c)/(d): the global semaphore bounding concurrent remote reads across the
// whole fleet, and the hand-off release the module's own comment calls out as
// load-bearing.
//
// WHY THIS SUITE COUNTS CONCURRENCY ITSELF RATHER THAN SAMPLING
// `fleetReadSlotsInUseForTest()`: that export reads the exact counter (`inUse`)
// the barging defect corrupts. Walk the broken version's timeline through —
// four tasks running, a fifth (E) queued; task A finishes and its release does
// `inUse` 4→3, shifts E, resolves E (E's continuation queues as a microtask);
// a SIXTH task (G) now calls `acquireSlot()`, sees `inUse` 3 < 4, takes the
// fast path, and resolves immediately, incrementing `inUse` to 4. E then runs,
// then G runs — FIVE tasks in flight while `inUse` reads 4. An instrument
// downstream of the defect (`fleetReadSlotsInUseForTest()`) reports the gate
// as respected at the exact moment it is breached. Only an INDEPENDENT counter
// — one this module's internals cannot touch — can see the fifth task.
//
// It also follows that the naive release is invisible to any assertion built
// from ORDER alone: E's resolve is still called strictly before G's, in both
// the correct and the broken version, so "the early waiter runs before the
// late arrival" never distinguishes them. That is why the second describe
// block below states plainly what it does and does not cover.

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetFleetReadGateForTest();
});

describe("runWithFleetReadSlot — global concurrency cap", () => {
  it("never admits more than FLEET_MAX_CONCURRENT_READS tasks at once, counted independently of the module's own accounting", async () => {
    // THE ARRIVAL-AFTER-HAND-OFF SHAPE, which is the whole trick: submitting
    // every task up front (as a naive version of this test would) can never
    // catch the defect, because every one of the first
    // `FLEET_MAX_CONCURRENT_READS` slots is a genuine `acquireSlot()` fast-path
    // grant and every release after that is a HAND-OFF — the fast-path branch
    // (the only place a decrement bug can matter) is never consulted again.
    // The bug only shows up for an arrival that calls `acquireSlot()` AFTER a
    // hand-off has already happened, so this submits a first wave, waits for
    // hand-offs to occur, and only THEN submits a second wave.
    let active = 0;
    let peak = 0;
    const runningTask = (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      return Promise.resolve().then(() => {
        active -= 1;
      });
    };

    const firstWaveSize = FLEET_MAX_CONCURRENT_READS * 2;
    const firstWaveGates = Array.from({ length: firstWaveSize }, () =>
      deferred<void>(),
    );
    const firstWaveRuns = firstWaveGates.map((gate) =>
      runWithFleetReadSlot(async () => {
        await gate.promise;
        await runningTask();
      }),
    );
    // Let the first `FLEET_MAX_CONCURRENT_READS` acquire their slots; the rest
    // queue.
    await Promise.resolve();
    await Promise.resolve();

    // Resolve exactly `FLEET_MAX_CONCURRENT_READS` of them, one at a time,
    // each producing a genuine HAND-OFF to the next queued waiter — this is
    // what advances the broken version's `inUse` counter down without any
    // corresponding increment.
    for (let index = 0; index < FLEET_MAX_CONCURRENT_READS; index += 1) {
      firstWaveGates[index].resolve();
      // Give this hand-off's microtask chain (release → shift → resolve →
      // the woken waiter's own continuation) a turn to fully settle before
      // starting the next one, and before the second wave arrives.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    // NOW submit the second wave — arrivals strictly AFTER the hand-offs
    // above. Under the correct gate these queue normally; under the broken
    // (decrement-on-hand-off) version, `inUse` has drifted down and these are
    // admitted immediately on top of whatever is still running.
    const secondWaveGates = Array.from(
      { length: FLEET_MAX_CONCURRENT_READS },
      () => deferred<void>(),
    );
    const secondWaveRuns = secondWaveGates.map((gate) =>
      runWithFleetReadSlot(async () => {
        await gate.promise;
        await runningTask();
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Drain everything still outstanding.
    firstWaveGates.slice(FLEET_MAX_CONCURRENT_READS).forEach((gate) => {
      gate.resolve();
    });
    secondWaveGates.forEach((gate) => {
      gate.resolve();
    });
    await Promise.all([...firstWaveRuns, ...secondWaveRuns]);

    expect(peak).toBeLessThanOrEqual(FLEET_MAX_CONCURRENT_READS);
  });

  it("releases the slot even when the task THROWS — a failing read must not leak fleet capacity", async () => {
    let active = 0;
    const gate = deferred<void>();
    const probe = runWithFleetReadSlot(async () => {
      active += 1;
      await gate.promise;
      throw new Error("borrowed session closed underneath the read");
    });
    await Promise.resolve();
    expect(active).toBe(1);
    gate.resolve();
    await expect(probe).rejects.toThrow(
      "borrowed session closed underneath the read",
    );
    // A slot the failing task leaked would still be free for the NEXT caller
    // to acquire immediately - assert that directly rather than reading the
    // module's own counter.
    let secondActive = 0;
    await runWithFleetReadSlot(() => {
      secondActive += 1;
      return Promise.resolve();
    });
    expect(secondActive).toBe(1);
  });
});

describe("runWithFleetReadSlot — hand-off order (regression guard, not a barging proof)", () => {
  it("a waiter queued BEFORE a late arrival runs first when a slot frees", async () => {
    // NOTE: this pins release ORDER, and order alone cannot distinguish the
    // correct hand-off from the broken decrement-then-shift version — in both,
    // the early waiter's `resolve()` is called strictly before the late
    // arrival's. See the module-level comment above for why the concurrency
    // suite, not this one, is where the barging class is actually caught.
    // Kept as a cheap regression guard on the simpler, always-true property.
    const holders = Array.from({ length: FLEET_MAX_CONCURRENT_READS }, () =>
      deferred<void>(),
    );
    let activeHolders = 0;
    const holderRuns = holders.map((gate) =>
      runWithFleetReadSlot(async () => {
        activeHolders += 1;
        await gate.promise;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(activeHolders).toBe(FLEET_MAX_CONCURRENT_READS);

    const order: string[] = [];
    const earlyWaiter = runWithFleetReadSlot(() => {
      order.push("early");
      return Promise.resolve();
    });
    await Promise.resolve();
    const lateArrival = runWithFleetReadSlot(() => {
      order.push("late");
      return Promise.resolve();
    });

    holders[0].resolve();
    await Promise.all([earlyWaiter, lateArrival]);
    expect(order).toEqual(["early", "late"]);

    holders.slice(1).forEach((gate) => {
      gate.resolve();
    });
    await Promise.all(holderRuns);
  });
});
