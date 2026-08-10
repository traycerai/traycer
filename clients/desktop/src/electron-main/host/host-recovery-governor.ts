import { log } from "../app/logger";

/**
 * The single authority for AUTOMATIC host respawns.
 *
 * ### Why this owns the liveness check
 *
 * The obvious place for "don't kill a host that is merely busy" is the health
 * monitor's tick, since that is where the decision is felt. That placement is
 * wrong: it protects one caller. Any other path to an automatic restart - the
 * controller's own recovery re-drive today, whatever is added tomorrow -
 * bypasses a check that lives in the monitor, and the host dies anyway. So the
 * gate lives HERE, in the function every automatic restart must call, and the
 * invariant is structural rather than remembered:
 *
 *   **No automatic respawn is granted while the host process exists.**
 *
 * Process EXISTENCE is the whole question, and deliberately so. An unreachable
 * endpoint tells us the main thread isn't serving; it cannot tell us whether
 * that is death or a 20-second `Y.applyUpdate` on a large epic - and under this
 * policy it doesn't need to, because busy, wedged and deadlocked all get the
 * same treatment: never auto-killed, manual Retry as the escape. A finer signal
 * (how much progress the event loop is making) would change no decision here,
 * so the desktop asks the only question whose answer it acts on.
 *
 * Deliberate user intent (Settings → Restart Host, the unavailable card's
 * Retry) does NOT come through here. That path is `HostController.respawn()`
 * and it is allowed to kill a busy or wedged host - it is the documented
 * escape hatch, and a user who asks for a restart has decided. It needs no
 * explicit "reset the breaker" hook either: a manual retry that works produces
 * a reachable host, and sustained reachability clears the budget on its own.
 * One that does NOT work leaves the breaker tripped, which is correct.
 *
 * ### Why the breaker counts consecutive grants, not grants per window
 *
 * A window-based breaker ("N restarts in M minutes") cannot fire once restarts
 * are spaced by a backoff: with 0s/60s/5m spacing, a 10-minute window holds at
 * most three grants, so a "5 in 10 minutes" rule is unreachable and the
 * promised "give up and show Retry" state never arrives - the host just
 * restarts forever, more slowly. Counting CONSECUTIVE grants that were never
 * interrupted by a sustained-health reset composes correctly with any backoff
 * schedule.
 */

/** Consecutive grants, with no intervening recovery, before giving up. */
export const BREAKER_MAX_CONSECUTIVE_GRANTS = 5;

/**
 * Minimum spacing between grants, indexed by how many have already been made.
 * The first recovery is immediate (the common case is a genuinely dead host);
 * repeats slow down fast. The last entry repeats for further attempts.
 */
export const RESPAWN_BACKOFF_MS: readonly number[] = [0, 60_000, 300_000];

/**
 * How long the host must stay continuously reachable before the attempt
 * counter is forgiven. A single successful probe deliberately does NOT reset
 * anything: that was the bug that made the original loop infinite, because
 * every freshly spawned host answers exactly one probe before stalling again,
 * re-arming the budget forever.
 */
export const SUSTAINED_HEALTH_MS = 300_000;

/**
 * Whether the published host process still exists.
 *
 * `dead` covers both "no such process" and a positively identified recycled
 * pid; anything else - including a probe that could not reach a conclusion - is
 * `alive`, because the cost of guessing wrong in that direction is killing a
 * working host, while the cost in the other is a wait for manual Retry.
 */
export type HostProcessLiveness = "alive" | "dead";

export type RespawnDecision =
  | { readonly kind: "granted" }
  | {
      /** The process exists. Never restart it automatically. */
      readonly kind: "denied";
      readonly reason: "alive";
    }
  | {
      /** Too soon after the last grant. */
      readonly kind: "denied";
      readonly reason: "backoff";
      readonly retryInMs: number;
    }
  | {
      /** Budget exhausted - recovery now belongs to the user. */
      readonly kind: "denied";
      readonly reason: "tripped";
    };

export interface HostRecoveryGovernorDeps {
  /**
   * Does the host process published in `pid.json` still exist? An ABSENT
   * pid.json resolves to `dead` - there is no process to protect, and a host
   * that has not yet bound is invisible here either way. An UNREADABLE one
   * resolves to `alive`: "I couldn't find out" is not evidence of death, and
   * must not buy a restart.
   */
  readonly readLiveness: () => Promise<HostProcessLiveness>;
  /** Test seam. */
  readonly now: (() => number) | undefined;
}

export interface HostRecoveryGovernor {
  requestRespawn(reason: string): Promise<RespawnDecision>;
  /** Call on every observation that the host is reachable. */
  noteHealthy(): void;
  /** Call on every observation that it is not. */
  noteUnhealthy(): void;
  /**
   * Return a grant that never turned into a restart (e.g. another process held
   * the CLI lock), so a deferral doesn't consume budget.
   */
  releaseGrant(): void;
  readonly isTripped: boolean;
}

export function createHostRecoveryGovernor(
  deps: HostRecoveryGovernorDeps,
): HostRecoveryGovernor {
  const now = deps.now ?? (() => Date.now());
  let consecutiveGrants = 0;
  let lastGrantAt: number | null = null;
  let healthySince: number | null = null;
  let tripped = false;

  const reset = (): void => {
    consecutiveGrants = 0;
    lastGrantAt = null;
    tripped = false;
  };

  const backoffForNextGrant = (): number => {
    const index = Math.min(consecutiveGrants, RESPAWN_BACKOFF_MS.length - 1);
    return RESPAWN_BACKOFF_MS[index];
  };

  return {
    get isTripped(): boolean {
      return tripped;
    },

    noteHealthy: (): void => {
      const at = now();
      if (healthySince === null) {
        healthySince = at;
        return;
      }
      if (at - healthySince < SUSTAINED_HEALTH_MS) return;
      // Sustained recovery: this host has proven itself, so previous attempts
      // no longer count against it.
      if (consecutiveGrants > 0 || tripped) {
        log.info(
          "[host-recovery] host healthy for the sustained window - clearing respawn budget",
          { consecutiveGrants, wasTripped: tripped },
        );
      }
      reset();
    },

    noteUnhealthy: (): void => {
      healthySince = null;
    },

    requestRespawn: async (reason: string): Promise<RespawnDecision> => {
      if (tripped) return { kind: "denied", reason: "tripped" };

      // THE invariant. Checked before the budget so an unreachable-but-alive
      // host never spends any of it, and checked here rather than in the caller
      // so every present and future automatic path inherits the protection.
      if ((await deps.readLiveness()) === "alive") {
        return { kind: "denied", reason: "alive" };
      }

      if (consecutiveGrants >= BREAKER_MAX_CONSECUTIVE_GRANTS) {
        tripped = true;
        log.warn(
          "[host-recovery] automatic respawns exhausted - handing recovery to the user",
          { reason, consecutiveGrants },
        );
        return { kind: "denied", reason: "tripped" };
      }

      const at = now();
      const backoffMs = backoffForNextGrant();
      if (lastGrantAt !== null && at - lastGrantAt < backoffMs) {
        return {
          kind: "denied",
          reason: "backoff",
          retryInMs: backoffMs - (at - lastGrantAt),
        };
      }

      consecutiveGrants += 1;
      lastGrantAt = at;
      healthySince = null;
      log.warn("[host-recovery] granting automatic respawn", {
        reason,
        attempt: consecutiveGrants,
        limit: BREAKER_MAX_CONSECUTIVE_GRANTS,
      });
      return { kind: "granted" };
    },

    releaseGrant: (): void => {
      // Clearing the clock alongside the count looks like it erases pacing an
      // earlier grant earned, but it cannot: the released grant only happened
      // because it already cleared the SAME backoff window (index
      // `consecutiveGrants - 1`) that the refunded state re-checks, so the next
      // request passes either way. Refund both and keep one source of truth.
      consecutiveGrants = Math.max(0, consecutiveGrants - 1);
      lastGrantAt = null;
    },
  };
}
