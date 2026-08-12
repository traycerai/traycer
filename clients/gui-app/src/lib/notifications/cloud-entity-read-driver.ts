import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import {
  selectCloudEntityReadRetries,
  selectCloudEntityReadTargets,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";

/**
 * Matches `NOTIFICATION_FEED_SYNC_RETRY_BASE_MS` in the host's notification
 * feed sync worker - the same kind of unit, a single failed feed request.
 */
export const CLOUD_ENTITY_READ_RETRY_BASE_MS = 1_000;
/**
 * Five minutes, which is both the host worker's
 * `NOTIFICATION_FEED_SYNC_RETRY_MAX_MS` and this app's existing
 * `HOST_STREAM_REOPEN_MAX_BACKOFF_MS`. A recovered server is picked
 * up within minutes; a broken one is a trickle.
 */
export const CLOUD_ENTITY_READ_RETRY_MAX_MS = 300_000;

export interface CloudEntityReadDeps {
  /** Resolves when the server accepted the marker, rejects otherwise. */
  readonly markRead: (entryId: string) => Promise<void>;
  readonly now: () => number;
  readonly random: () => number;
}

/**
 * Drives view-consumption mark-reads for the cloud feed.
 *
 * Retrying is safe BY CONSTRUCTION - markers are set-once and min-merged, so a
 * repeat can only ever be a no-op - which makes volume, not correctness, the
 * only thing to bound. So this does not suppress retries; it paces them:
 *
 * - at most ONE request in flight across the whole fan-out, matching the host
 *   sync worker's single-flight `flushing` discipline;
 * - a failure schedules the entry's next attempt with exponential backoff;
 * - a success clears the entry's state and records it as accepted, so a feed
 *   that keeps replaying the row as unread costs nothing.
 *
 * Module-level rather than per-hook: the loop has to outlive any single render
 * and stay single-flight across every caller.
 */
let inFlight = false;
let retryTimer: TimerHandle | null = null;
interface CloudEntityReadScope {
  readonly originHostId: string | null;
  readonly entity: HostNotificationsEntityRef;
}

let queuedScope: CloudEntityReadScope | null = null;
/**
 * Bumped by every reset. Both continuations that can outlive the caller - the
 * armed retry timer and the in-flight loop's own re-entry - capture it and
 * stand down if it moved.
 *
 * Without this, a reset is only half a stop: it clears the timer, but the
 * async pass already running re-enters in its `finally` and re-arms a new one
 * from the generation that was just torn down. Both continuations carry `deps`
 * captured from one render, so anything they schedule after teardown would run
 * against a mutation client and relay session that no longer exist.
 */
let generation = 0;

/**
 * Jitter over [50%, 100%] of the exponential rather than AWS "full jitter"
 * over [0, exp]. Full jitter can draw a near-zero delay repeatedly, which
 * under single-flight turns a persistently failing server into a tight
 * sequential loop - the opposite of the decay this is for. Half-to-full still
 * decorrelates windows/devices retrying the same feed, while keeping the rate
 * strictly decreasing.
 */
export function cloudEntityReadBackoffMs(
  attempts: number,
  random: () => number,
): number {
  const exponential = Math.min(
    CLOUD_ENTITY_READ_RETRY_MAX_MS,
    CLOUD_ENTITY_READ_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
  );
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/**
 * Ask the driver to bring `entity` up to date. Safe to call on every presence
 * change and every snapshot: it writes nothing when there is nothing to do,
 * and coalesces into the in-flight pass rather than starting a second one.
 */
export function requestCloudEntityRead(
  originHostId: string | null,
  entity: HostNotificationsEntityRef,
  deps: CloudEntityReadDeps,
): void {
  if (inFlight) {
    queuedScope = { originHostId, entity };
    return;
  }
  const state = useCloudNotificationsStore.getState();
  const { due, dropped } = selectCloudEntityReadRetries(state, deps.now());
  state.clearEntityReadRetries(dropped);
  const discovered = selectCloudEntityReadTargets(state, entity, originHostId);
  const entryIds = [...due, ...discovered];
  // Nothing to do: return WITHOUT touching the store. This runs on every
  // accepted snapshot, and a no-op that still wrote would re-trigger itself.
  if (entryIds.length === 0) {
    scheduleNextAttempt({ originHostId, entity }, deps);
    return;
  }
  // Atomic claim + optimistic markers: the in-flight claim is visible to any
  // subscriber the row change wakes, so nothing can start a parallel pass.
  state.beginEntityRead(entryIds, deps.now());
  inFlight = true;
  const passGeneration = generation;
  void (async (): Promise<void> => {
    try {
      for (const entryId of entryIds) {
        try {
          await deps.markRead(entryId);
          useCloudNotificationsStore
            .getState()
            .recordEntityReadSuccess(entryId);
        } catch {
          // Availability state is owned by the mutation's own onError. Here we
          // only decide when this entry may be tried again, and keep going so
          // one bad entry does not strand the rest of the batch.
          const attempts =
            (useCloudNotificationsStore.getState().entityReadRetries[entryId]
              ?.attempts ?? 0) + 1;
          useCloudNotificationsStore
            .getState()
            .recordEntityReadFailure(
              entryId,
              deps.now() + cloudEntityReadBackoffMs(attempts, deps.random),
            );
        }
      }
    } finally {
      // A reset during the pass already cleared the claim and moved on. Re-
      // entering here would revive the torn-down generation - and arm a fresh
      // timer holding its dead `deps`.
      if (generation === passGeneration) {
        inFlight = false;
        const next = queuedScope ?? { originHostId, entity };
        queuedScope = null;
        // Re-enter once: picks up anything that arrived mid-pass, and
        // otherwise falls through to arming the backoff timer.
        requestCloudEntityRead(next.originHostId, next.entity, deps);
      }
    }
  })();
}

/** Arms a single timer for the soonest parked entry, so a retry happens even
 * if no snapshot or presence change ever comes. */
function scheduleNextAttempt(
  scope: CloudEntityReadScope,
  deps: CloudEntityReadDeps,
): void {
  if (retryTimer !== null) return;
  const retries = useCloudNotificationsStore.getState().entityReadRetries;
  let soonest = Number.POSITIVE_INFINITY;
  for (const retry of Object.values(retries)) {
    if (retry !== undefined && retry.nextEligibleAt < soonest) {
      soonest = retry.nextEligibleAt;
    }
  }
  if (!Number.isFinite(soonest)) return;
  const delayMs = Math.max(0, soonest - deps.now());
  const armedGeneration = generation;
  retryTimer = globalThis.setTimeout(() => {
    // Belt and braces with `resetCloudEntityReadDriver`'s `clearTimeout`: a
    // timer that already fired into the macrotask queue before the reset ran
    // cannot be cancelled, so it has to check for itself.
    if (generation !== armedGeneration) return;
    retryTimer = null;
    requestCloudEntityRead(scope.originHostId, scope.entity, deps);
  }, delayMs);
}

/**
 * Drops the in-flight claim, the queued entity and any armed timer, and
 * invalidates every continuation the previous generation could still run.
 *
 * Called wherever the relay session's ownership ends - including provider
 * UNMOUNT, which owns nothing else here: an armed retry timer is re-armed on
 * each failure, so without this a persistently failing server keeps a chain of
 * timers alive past teardown, firing host RPCs through a mutation client and
 * relay session that are gone.
 */
export function resetCloudEntityReadDriver(): void {
  generation += 1;
  inFlight = false;
  queuedScope = null;
  if (retryTimer !== null) {
    globalThis.clearTimeout(retryTimer);
    retryTimer = null;
  }
}
