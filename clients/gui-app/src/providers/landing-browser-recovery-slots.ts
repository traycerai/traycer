/**
 * Which devices the tombstone recovery bridge puts on a browser stream, and
 * when one of them has to give its slot up.
 *
 * The bridge holds at most `LANDING_BROWSER_RECOVERY_HOST_CAP` browser streams
 * (see that constant for the budget it is spending). Choosing them cannot be
 * "the oldest tombstones with a route", because a route is PERMISSION to dial
 * and not evidence anyone is home: `dialableHostEndpointFor` deliberately
 * admits an `indeterminate` remote entry, and a device in that state can hold a
 * slot forever without ever publishing an inventory. Two of those at the head
 * of the list starve every device behind them, and their tombstones - which are
 * the reason the bridge exists - never drain.
 *
 * So a slot is a LEASE. A device holds it for an attempt budget and goes to
 * the back of the queue when that runs out with its tombstones still
 * outstanding, keeping them. Reaching the device buys one more budget rather
 * than tenure: a slot is for DRAINING, and a device that answers and cannot
 * discharge its tombstones is holding one the queue behind it could use.
 * Nothing is ever dropped; only the order and the concurrency are decided
 * here.
 *
 * Concurrency, and only concurrency. Whether a refused close is ever sent
 * again is not this module's question - `landing-browser-tombstone-drain`
 * answers it on a timer of its own, precisely because a device with no queue
 * behind it is never rotated and still has a tombstone to discharge.
 *
 * Pure, and the whole policy: the bridge supplies the evidence and the clock.
 */

/**
 * How long a cohort of devices holds its slots before the queue behind it gets
 * a turn.
 *
 * A stream that reaches its device answers with a snapshot as its first frame,
 * so this is not a "how fast is the device" budget - it is how long a device
 * may keep a slot without discharging what it was given one for. Long enough
 * for a cold relay dial and a host still starting up, and then once more for
 * the closes that follow the snapshot, short enough that a queue of stuck
 * devices rotates within a minute or so per slot.
 */
export const LANDING_BROWSER_RECOVERY_ATTEMPT_MS = 30_000;

/**
 * The recovery queue: for every device that has given a slot up, the order in
 * which it did. A device that has never yielded is absent, and outranks every
 * device that has.
 *
 * An ORDER and not a timestamp, deliberately. Selection runs while RENDERING,
 * so it must not read the clock - `Date.now()` in a render makes the mounted
 * list change without an input having moved, which is a re-render React is
 * entitled to perform at any time and a stream churn the user would see. Time
 * still governs the policy; it is spent in the timer that decides WHEN a cohort
 * yields, never in the function that reads what it wrote.
 */
export type LandingBrowserRecoveryQueue = ReadonlyMap<string, number>;

/**
 * The devices to mount, in the order they should get slots.
 *
 * `candidateHostIds` is the bridge's own list: tombstoned devices with a route,
 * oldest tombstone first, deduped. Devices that have never yielded keep that
 * order and come first; devices that have are ordered by how long ago they did,
 * so the queue is round-robin rather than oldest-wins.
 */
export function selectLandingBrowserRecoveryHostIds(args: {
  readonly candidateHostIds: readonly string[];
  readonly queue: LandingBrowserRecoveryQueue;
  readonly cap: number;
}): readonly string[] {
  const ordered = [...args.candidateHostIds].sort((left, right) => {
    const leftYield = args.queue.get(left);
    const rightYield = args.queue.get(right);
    if (leftYield === undefined && rightYield === undefined) return 0;
    // A device that has never yielded outranks one that has; between two that
    // have, the one that yielded longest ago goes first. `sort` is stable, so
    // equal ranks keep the caller's tombstone order.
    if (leftYield === undefined) return -1;
    if (rightYield === undefined) return 1;
    return leftYield - rightYield;
  });
  return ordered.slice(0, args.cap);
}

/**
 * The queue after `yieldingHostIds` gave their slots up: each goes to the back,
 * in the order given.
 *
 * Devices that are no longer candidates are forgotten on the way through, so
 * the map cannot outgrow the fleet across a long session. A device that leaves
 * the candidate list has either drained its tombstones or lost its route -
 * either way its next appearance is new evidence and deserves a fresh attempt
 * rather than the place in the queue it left behind.
 */
export function yieldLandingBrowserRecoveryHosts(args: {
  readonly queue: LandingBrowserRecoveryQueue;
  readonly candidateHostIds: readonly string[];
  readonly yieldingHostIds: readonly string[];
}): LandingBrowserRecoveryQueue {
  const candidates = new Set(args.candidateHostIds);
  const next = new Map<string, number>();
  let nextOrder = 0;
  for (const [hostId, order] of args.queue) {
    if (!candidates.has(hostId)) continue;
    next.set(hostId, order);
    nextOrder = Math.max(nextOrder, order + 1);
  }
  for (const hostId of args.yieldingHostIds) {
    if (!candidates.has(hostId)) continue;
    next.set(hostId, nextOrder);
    nextOrder += 1;
  }
  return next;
}

/** Do these two queues say the same thing? */
export function landingBrowserRecoveryQueuesEqual(
  left: LandingBrowserRecoveryQueue,
  right: LandingBrowserRecoveryQueue,
): boolean {
  if (left.size !== right.size) return false;
  for (const [hostId, order] of left) {
    if (right.get(hostId) !== order) return false;
  }
  return true;
}
