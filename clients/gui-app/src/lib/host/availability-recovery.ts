import { appLogger } from "@/lib/logger";

/**
 * Bridges stream-transport recovery evidence onto the query layer.
 *
 * `HostClient.notifyAvailabilityRecovered()` is the designed escape hatch for
 * host-scoped queries stranded in a permanent error state (every automatic
 * TanStack recovery route is deliberately disabled for host RPCs - transport
 * retries already ran, no polling, no focus/reconnect refetch). This module
 * gives it its production callers: the app-wide `WsStreamClient` heartbeats
 * against the ACTIVE host, and every durable per-tab transport heartbeats its
 * BOUND host, so their availability evidence (a session re-opening after a
 * drop, or a pong landing after a stall-length gap) is exactly the "endpoint
 * recovered" signal the method's contract asks for. Without this, a host
 * event-loop stall that outlives the unary dial+retry budget leaves panels
 * (terminals, git-diff, file-tree) errored forever with no path back.
 */

/**
 * Minimum spacing between two notify calls from one wiring. When a stall
 * clears, every open stream session observes recovery within milliseconds of
 * each other; the first notification refetches all active host-scoped
 * queries, so the follow-ups inside the window add nothing but refetch churn.
 */
export const AVAILABILITY_RECOVERY_COOLDOWN_MS = 10_000;

export interface AvailabilityEvidenceSource {
  subscribeAvailabilityRecovered(listener: () => void): () => void;
}

export interface AvailabilityRecoveryTarget {
  notifyAvailabilityRecovered(): void;
}

/**
 * Subscribes `target` to the stream client's recovery evidence, cooldown-
 * coalesced. Returns a disposer that also cancels any armed trailing notify.
 * `now` is injected so tests control the clock.
 *
 * The gate is leading-edge WITH a trailing catch-up: evidence outside the
 * cooldown notifies immediately; evidence inside it arms ONE deferred notify
 * at window end instead of being dropped. The trailing half matters because a
 * suppressed emission can be a DISTINCT second recovery episode (stall →
 * recover → notify, then stall again → recover at t+3s) whose newly-stranded
 * queries have no other automatic signal - swallowing it would strand them
 * until the next stall. A backwards `now` step (clock adjustment) resets the
 * gate rather than suppressing under a future-dated watermark. Whenever the
 * leading edge is taken, any armed catch-up is cancelled, so the two halves
 * can never both deliver the same episode.
 */
export function wireAvailabilityRecovery(args: {
  readonly wsStreamClient: AvailabilityEvidenceSource;
  readonly target: AvailabilityRecoveryTarget;
  readonly cooldownMs: number;
  readonly now: () => number;
}): () => void {
  let lastNotifiedAt: number | null = null;
  let trailingTimer: number | null = null;
  const notify = (): void => {
    // Any notify supersedes an armed catch-up: the trailing timer exists only
    // to deliver an episode that was suppressed, and this call just delivered
    // one. Two paths reach the leading edge with a timer still armed - a clock
    // rollback resetting the gate, and (in this feature's own scenario) a
    // stalled event loop dispatching an evidence message before the timer it
    // already owes. Leaving the timer armed fires a duplicate invalidation
    // moments later, which is exactly the churn the cooldown exists to stop.
    if (trailingTimer !== null) {
      window.clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    lastNotifiedAt = args.now();
    appLogger.info(
      "[stream] host availability recovered - refetching host-scoped queries",
      {},
    );
    args.target.notifyAvailabilityRecovered();
  };
  const disposeEvidence = args.wsStreamClient.subscribeAvailabilityRecovered(
    () => {
      const at = args.now();
      if (lastNotifiedAt !== null && at < lastNotifiedAt) {
        lastNotifiedAt = null;
      }
      if (lastNotifiedAt === null || at - lastNotifiedAt >= args.cooldownMs) {
        notify();
        return;
      }
      if (trailingTimer !== null) {
        return;
      }
      trailingTimer = window.setTimeout(
        () => {
          trailingTimer = null;
          notify();
        },
        args.cooldownMs - (at - lastNotifiedAt),
      );
    },
  );
  return () => {
    disposeEvidence();
    if (trailingTimer !== null) {
      window.clearTimeout(trailingTimer);
      trailingTimer = null;
    }
  };
}
