import type { TransitionGovernor } from "../durable/records";
import type { TransitionFailureClass } from "./types";

const LWCR_FAILURE_CLASS: TransitionFailureClass = "lwcr";

export const EMPTY_TRANSITION_GOVERNOR: TransitionGovernor = {
  lastAttemptedBuildId: null,
  lastAttemptedCDHash: null,
  failureClass: null,
  attemptCount: 0,
  nextEligibleAt: null,
  breaker: null,
  lastSustainedHealthAt: null,
};

export type GovernorEligibility =
  | {
      readonly kind: "eligible";
      readonly reason: "initial" | "elapsed" | "lwcr-cdhash-change";
    }
  | { readonly kind: "blocked"; readonly until: string };

/**
 * A new CDHash may bypass delay only after an LWCR failure.  Other classes
 * deliberately retain their backoff: a new build cannot prove a transient
 * endpoint failure or ambiguous probe was repaired.
 */
export function evaluateGovernorEligibility(input: {
  readonly governor: TransitionGovernor;
  readonly now: string;
  readonly cdHash: string | null;
}): GovernorEligibility {
  if (input.governor.attemptCount === 0) {
    return { kind: "eligible", reason: "initial" };
  }
  if (
    input.governor.failureClass === LWCR_FAILURE_CLASS &&
    input.cdHash !== null &&
    input.cdHash !== input.governor.lastAttemptedCDHash
  ) {
    return { kind: "eligible", reason: "lwcr-cdhash-change" };
  }
  if (
    input.governor.nextEligibleAt === null ||
    input.governor.nextEligibleAt <= input.now
  ) {
    return { kind: "eligible", reason: "elapsed" };
  }
  // A breaker is a persisted failure signal, not a permanent lockout. It
  // shares the durable retry deadline with ordinary backoff, and a successful
  // retry clears it in the terminal journal write. This makes `until` an
  // honest, actionable time rather than the former unusable `null`.
  return { kind: "blocked", until: input.governor.nextEligibleAt };
}

export function recordTransitionFailure(input: {
  readonly previous: TransitionGovernor;
  readonly failureClass: TransitionFailureClass;
  readonly buildId: string | null;
  readonly cdHash: string | null;
  readonly now: string;
  readonly nextEligibleAt: string;
  readonly breakerAfterAttempts: number;
}): TransitionGovernor {
  const attemptCount = input.previous.attemptCount + 1;
  return {
    lastAttemptedBuildId: input.buildId,
    lastAttemptedCDHash: input.cdHash,
    failureClass: input.failureClass,
    attemptCount,
    nextEligibleAt: input.nextEligibleAt,
    breaker:
      attemptCount >= input.breakerAfterAttempts
        ? "open"
        : input.previous.breaker,
    lastSustainedHealthAt: input.previous.lastSustainedHealthAt,
  };
}

/** Only a positively sustained healthy interval may clear the breaker. */
export function recordSustainedTransitionHealth(input: {
  readonly previous: TransitionGovernor;
  readonly at: string;
}): TransitionGovernor {
  return {
    lastAttemptedBuildId: input.previous.lastAttemptedBuildId,
    lastAttemptedCDHash: input.previous.lastAttemptedCDHash,
    failureClass: null,
    attemptCount: 0,
    nextEligibleAt: null,
    breaker: null,
    lastSustainedHealthAt: input.at,
  };
}
