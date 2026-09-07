import { FLEET_MAX_CONCURRENT_READS } from "@/lib/host/fleet-update/fleet-poll-policy";

/** The GLOBAL cap on remote update reads in flight, shared by every host. */
const waiters: Array<() => void> = [];
let inUse = 0;

/** Runs `task` while holding one of the fleet's read slots. */
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
    // NO DECREMENT ON THIS PATH.
    // The slot is HANDED OVER: this caller's accounting becomes the woken waiter's, so `inUse` is already correct.
    nextWaiter();
    return;
  }
  inUse -= 1;
}

/** How many slots this module BELIEVES are held right now. */
export function fleetReadSlotsInUseForTest(): number {
  return inUse;
}

export function resetFleetReadGateForTest(): void {
  waiters.length = 0;
  inUse = 0;
}
