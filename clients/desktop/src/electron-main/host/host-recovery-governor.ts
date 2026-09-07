import { log } from "../app/logger";

/** Automatic respawn gate: never grant while the host process exists. */

/** Consecutive grants with no intervening recovery before giving up. */
export const BREAKER_MAX_CONSECUTIVE_GRANTS = 5;

/** Spacing between grants by how many have already been made; last entry repeats. */
export const RESPAWN_BACKOFF_MS: readonly number[] = [0, 60_000, 300_000];

/** Host must stay reachable this long before the attempt counter is forgiven; one successful probe does not reset. */
export const SUSTAINED_HEALTH_MS = 300_000;

/** `dead` is no process or a recycled pid; inconclusive probes are `alive`. */
export type HostProcessLiveness = "alive" | "dead";

export type RespawnDecision =
  | { readonly kind: "granted" }
  | {
      /** Process exists; never auto-restart. */
      readonly kind: "denied";
      readonly reason: "alive";
    }
  | {
      readonly kind: "denied";
      readonly reason: "backoff";
      readonly retryInMs: number;
    }
  | {
      readonly kind: "denied";
      readonly reason: "tripped";
    };

export interface HostRecoveryGovernorDeps {
  /** Absent pid.json is `dead`; unreadable is `alive`. */
  readonly readLiveness: () => Promise<HostProcessLiveness>;
  readonly now: (() => number) | undefined;
}

export interface HostRecoveryGovernor {
  requestRespawn(reason: string): Promise<RespawnDecision>;
  noteHealthy(): void;
  noteUnhealthy(): void;
  /** Return a grant that never became a restart so a deferral does not consume budget. */
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

      // Alive process spends no budget; checked here so every automatic path inherits it.
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
      // Refund count and clock together; the released grant already cleared this backoff window.
      consecutiveGrants = Math.max(0, consecutiveGrants - 1);
      lastGrantAt = null;
    },
  };
}
