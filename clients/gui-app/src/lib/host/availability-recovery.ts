import { appLogger } from "@/lib/logger";

/** Bridges stream-transport recovery evidence onto the query layer. */

/**
 * Minimum spacing between two notify calls from one wiring.
 * When a stall clears, every open stream session observes recovery within milliseconds of each other; the first notification refetches all active host-scoped queries, so the follow-ups inside the window add nothing but refetch churn.
 */
export const AVAILABILITY_RECOVERY_COOLDOWN_MS = 10_000;

export interface AvailabilityEvidenceSource {
  subscribeAvailabilityRecovered(listener: () => void): () => void;
}

/** Where one wiring's recovery evidence lands. */
export interface NamedHostRecoveryTarget {
  notifyRecoveredForNamedHost(): void;
}

/**
 * Subscribes `target` to the stream client's recovery evidence, cooldown- coalesced.
 * Returns a disposer that also cancels any armed trailing notify.
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
    // Any notify supersedes an armed catch-up: the trailing timer exists only to deliver an episode that was suppressed, and this call just delivered one.
    // Two paths reach the leading edge with a timer still armed - a clock rollback resetting the gate, and (in this feature's own scenario) a stalled event loop dispatching an evidence message before the timer it already owes.
    if (trailingTimer !== null) {
      window.clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    lastNotifiedAt = args.now();
    // Debug, not info: this fires once per stream client (a dozen or more per window), and the host-scope sweep it feeds is coalesced per host below this wiring.
    // The sweep logs itself, with counts, in `createHostQueryInvalidator`; counting THESE lines as sweeps over-reported a 2026-09-03 field investigation by the client count.
    appLogger.debug("[stream] host availability recovered", {});
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
