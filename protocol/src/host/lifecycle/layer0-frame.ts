/**
 * The Layer 0 status frame: a host -> client wire payload.
 * One declaration, imported by both sides, is the only version of this that cannot drift.
 */

/** Why Layer 0 could not establish a trusted verdict. */
export type Layer0UnavailableCause =
  | "addon-load-failed"
  | "fs-unsupported"
  | "lock-path-invalid"
  // Windows only.
  | "sharing-violation-unattested"
  | {
      readonly kind: "os-error";
      readonly syscall: string;
      readonly code: string;
      readonly fsType: string | null;
    };

/** What the loser of a contention learned about the winner. */
export type Layer0IncumbentEvidence =
  | {
      readonly kind: "pid-metadata";
      readonly pid: number;
      readonly hostId: string;
      readonly startedAt: string;
    }
  | {
      readonly kind: "held-retry-window";
      readonly lockPath: string;
      readonly observedForMs: number;
    };

/**
 * Exactly three outcomes, because `layer0PreventsStartup` is total over them and only `declined` may stop a start.
 * There is deliberately no `unavailable` variant: an unavailable lock is a `degraded` start, not a fourth state - a new safety mechanism must never make availability worse than not having it.
 */
export type Layer0Frame =
  | { readonly attemptId: string; readonly layer0: "acquired" }
  | {
      readonly attemptId: string;
      readonly layer0: "declined";
      readonly incumbentEvidence: Layer0IncumbentEvidence;
    }
  | {
      readonly attemptId: string;
      readonly layer0: "degraded";
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    };
