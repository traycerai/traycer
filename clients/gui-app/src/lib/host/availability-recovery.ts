import { appLogger } from "@/lib/logger";

/**
 * Bridges stream-transport recovery evidence onto the query layer.
 *
 * `HostClient.notifyHostAvailabilityRecovered(hostId)` is the designed escape
 * hatch for host-scoped queries stranded in a permanent error state (every
 * automatic TanStack recovery route is deliberately disabled for host RPCs -
 * transport retries already ran, no polling, no focus/reconnect refetch). This
 * module gives it its production callers: the app-wide stream heartbeats the
 * effective host and every durable per-tab transport heartbeats the host its
 * tab is pinned to, so their availability evidence (a session re-opening after
 * a drop, or a pong landing after a stall-length gap) is exactly the "endpoint
 * recovered" signal the method's contract asks for. Every report NAMES its
 * host: P4.2 deleted the no-argument sibling that read the active slot, so
 * there is no privileged host to recover on any more. Without this, a host
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

/**
 * Where one wiring's recovery evidence lands.
 *
 * The member takes NO host argument, and that is a statement about this
 * interface rather than an omission: a target is constructed for exactly one
 * host and closes over it, so the host is already named by the time anything
 * calls in. The two implementations say so plainly - the app-wide stream binds
 * the host it heartbeats, a durable transport binds the host its tab is
 * pinned to.
 *
 * It used to be `AvailabilityRecoveryTarget.notifyAvailabilityRecovered()`,
 * which spelled the no-arg method the active slot exposed on `HostClient` -
 * the one that read the slot to work out whose queries to un-strand, and that
 * P4.2 deleted for becoming a silent permanent no-op. Nothing here ever had
 * that defect; the name simply outlived the thing it echoed, and a member
 * whose spelling implies a privileged host is how a reader concludes the two
 * are related.
 */
export interface NamedHostRecoveryTarget {
  notifyRecoveredForNamedHost(): void;
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
  readonly target: NamedHostRecoveryTarget;
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
    args.target.notifyRecoveredForNamedHost();
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
