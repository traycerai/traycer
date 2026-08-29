import { FLEET_MAX_CONCURRENT_READS } from "@/lib/host/fleet-update/fleet-poll-policy";

/**
 * The GLOBAL cap on remote update reads in flight, shared by every host.
 *
 * WHY THIS EXISTS AS A MODULE AND NOT A LOOP. The first shape of the fleet
 * sweep batched inside one `queryFn`: it sliced the host list into groups of
 * four and awaited each group. That bounds a burst only while all the reads
 * live in ONE function. Observation is now host-keyed — one query per host,
 * each on its own cadence — so there is no longer a single call site that could
 * hold a batch loop, and four `Promise.all`s of one host each is not a cap on
 * anything. The bound has to live where every read passes through it, which is
 * here.
 *
 * The number is unchanged ({@link FLEET_MAX_CONCURRENT_READS}); what changed is
 * that it is now enforced across the whole fleet rather than within a group.
 *
 * ⚠ THE RELEASE PATH HANDS THE SLOT OVER RATHER THAN DECREMENTING. A release
 * written as `inUse -= 1; wakeNextWaiter()` looks equivalent and is not: it
 * opens a window in which the counter is below the cap and no waiter has run
 * yet, so a caller arriving in that window takes the slot ahead of a waiter
 * that has been queued the whole time. Under a steady arrival rate — which is
 * exactly what a fleet of per-host pollers produces — that starves the queue
 * indefinitely while the cap still reads as respected. Handing the slot
 * directly to the head of the queue keeps `inUse` at the cap across the
 * transition, so there is no window to barge into.
 */
const waiters: Array<() => void> = [];
let inUse = 0;

/**
 * Runs `task` while holding one of the fleet's read slots.
 *
 * The slot is released on every path including a throw, because a read that
 * fails is the common case here, not the exceptional one: a borrowed session
 * can be closed by its owner at any moment and the read rejects. A leak on that
 * path would retire the fleet's capacity one dropped session at a time and
 * present as "badges stopped updating", with nothing in the logs.
 */
export async function runWithFleetReadSlot<T>(
  task: () => Promise<T>,
): Promise<T> {
  await acquireSlot();
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

function acquireSlot(): Promise<void> {
  if (inUse < FLEET_MAX_CONCURRENT_READS) {
    inUse += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function releaseSlot(): void {
  const nextWaiter = waiters.shift();
  if (nextWaiter !== undefined) {
    // ⚠ NO DECREMENT ON THIS PATH. The slot is HANDED OVER: this caller's
    // accounting becomes the woken waiter's, so `inUse` is already correct.
    //
    // This has been rewritten once to `inUse -= 1` above the shift, so the
    // warning is concrete rather than hypothetical — and the real consequence
    // is worse than the barging the module note describes. `acquireSlot`
    // increments ONLY on the fast path; a woken waiter never increments,
    // because under hand-off it inherits a slot that was never released. A
    // decrement here therefore loses one from `inUse` on every hand-off while
    // the same number of tasks keep running: after four hand-offs `inUse`
    // reads 0 with four reads in flight, and the cap admits four more. The
    // bound does not merely become unfair, it stops existing — silently, with
    // every counter still looking plausible.
    nextWaiter();
    return;
  }
  inUse -= 1;
}

/**
 * How many slots this module BELIEVES are held right now.
 *
 * ⚠ DO NOT ASSERT THE CONCURRENCY BOUND WITH THIS. It is the gate's own
 * bookkeeping, and the failure mode that bookkeeping actually suffers is
 * corruption of this very number — the decrement-on-hand-off bug above leaves
 * `inUse` reading 4 while five tasks run, so a cap test built on this helper
 * reports success at the exact moment the cap has been breached. An instrument
 * that is downstream of the defect cannot detect the defect.
 *
 * A real cap test counts ACTUAL concurrent entries and exits inside the task
 * bodies and asserts the peak of that. This exists only for diagnosing a
 * suspected slot leak — "did every release run?" — where the counter is the
 * thing under inspection rather than the evidence.
 */
export function fleetReadSlotsInUseForTest(): number {
  return inUse;
}

export function resetFleetReadGateForTest(): void {
  waiters.length = 0;
  inUse = 0;
}
