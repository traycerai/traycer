import {
  EMPTY_TRANSITION_GOVERNOR,
  recordSustainedTransitionHealth,
  recordTransitionFailure,
} from "../transition/governor";
import { advanceWriteAheadJournal } from "../transition/journal";
import type {
  ActivationFailureClass,
  ActivationPhase,
  LifecycleActivationJournal,
} from "./types";

export function createActivationJournal(input: {
  readonly fromGeneration: string;
  readonly toGeneration: string;
  readonly governor: LifecycleActivationJournal["governor"] | null;
}): LifecycleActivationJournal {
  return {
    v: 1,
    fromGeneration: input.fromGeneration,
    toGeneration: input.toGeneration,
    phase: "claiming-stop",
    stopClaimToken: null,
    attempt: null,
    rollbackFailure: null,
    governor: input.governor ?? EMPTY_TRANSITION_GOVERNOR,
    terminal: null,
  };
}

/** The same write-ahead convention used by the transition journal. */
export function advanceActivationJournal(input: {
  readonly journal: LifecycleActivationJournal;
  readonly phase: ActivationPhase;
  readonly attemptId: string | null;
  readonly rollbackFailure: ActivationFailureClass | null;
  readonly stopClaimToken: string | null;
}): LifecycleActivationJournal {
  if (isActivationTerminalPhase(input.journal.phase)) {
    throw new Error(
      `Cannot advance terminal activation ${input.journal.toGeneration}`,
    );
  }
  return {
    ...advanceWriteAheadJournal(input.journal, input.phase),
    stopClaimToken: input.stopClaimToken,
    attempt:
      input.phase === "verifying" && input.attemptId !== null
        ? { state: "installed-not-ready", attemptId: input.attemptId }
        : null,
    rollbackFailure: input.rollbackFailure,
  };
}

export function finishActivationJournal(input: {
  readonly journal: LifecycleActivationJournal;
  readonly now: string;
}): LifecycleActivationJournal {
  return {
    ...input.journal,
    phase: "done",
    stopClaimToken: null,
    attempt: null,
    rollbackFailure: null,
    governor: recordSustainedTransitionHealth({
      previous: input.journal.governor,
      at: input.now,
    }),
    terminal: { outcome: "done", failureClass: null, failurePhase: null },
  };
}

export function failActivationJournal(input: {
  readonly journal: LifecycleActivationJournal;
  readonly failureClass: ActivationFailureClass;
  readonly buildId: string | null;
  readonly cdHash: string | null;
  readonly now: string;
  readonly nextEligibleAt: string;
  readonly breakerAfterAttempts: number;
  readonly failurePhase: ActivationPhase;
}): LifecycleActivationJournal {
  return {
    ...input.journal,
    phase: "failed",
    stopClaimToken: null,
    attempt: null,
    rollbackFailure: null,
    governor: recordTransitionFailure({
      previous: input.journal.governor,
      failureClass: input.failureClass,
      buildId: input.buildId,
      cdHash: input.cdHash,
      now: input.now,
      nextEligibleAt: input.nextEligibleAt,
      breakerAfterAttempts: input.breakerAfterAttempts,
    }),
    terminal: {
      outcome: "failed",
      failureClass: input.failureClass,
      failurePhase: input.failurePhase,
    },
  };
}

export function isActivationTerminalPhase(
  phase: ActivationPhase,
): phase is "done" | "failed" {
  return phase === "done" || phase === "failed";
}
