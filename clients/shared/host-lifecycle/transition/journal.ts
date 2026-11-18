import type { TransitionGovernor } from "../durable/records";
import {
  EMPTY_TRANSITION_GOVERNOR,
  recordSustainedTransitionHealth,
  recordTransitionFailure,
} from "./governor";
import type {
  LifecycleTransitionJournal,
  SubstrateTransitionKind,
  TransitionFailureClass,
  TransitionPhase,
} from "./types";

/**
 * Shared durable-journal convention for lifecycle mutations.  The caller
 * persists the returned snapshot before performing the mutation named by its
 * phase.  Keeping this primitive here makes the activation and substrate
 * journals one convention rather than two similar-looking implementations.
 */
export function advanceWriteAheadJournal<
  Phase extends string,
  Journal extends {
    readonly phase: Phase;
    readonly terminal: unknown;
  },
>(
  journal: Journal,
  phase: Phase,
): Omit<Journal, "phase" | "terminal"> & {
  readonly phase: Phase;
  readonly terminal: null;
} {
  return { ...journal, phase, terminal: null };
}

export function createTransitionJournal(input: {
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly kind: SubstrateTransitionKind;
  readonly from: "smappservice" | "raw-fallback";
  readonly to: "smappservice" | "raw-fallback";
  readonly phase: TransitionPhase;
  readonly expectedIdentities: readonly string[];
  readonly startedAt: string;
  readonly governor: TransitionGovernor | null;
}): LifecycleTransitionJournal {
  return {
    v: 1,
    transitionId: input.transitionId,
    probeNonce: input.probeNonce,
    kind: input.kind,
    from: input.from,
    to: input.to,
    phase: input.phase,
    expectedIdentities: input.expectedIdentities,
    compensation: input.kind === "reclaim" ? "reprovision-fallback" : null,
    startedAt: input.startedAt,
    probeDeadlineAt: null,
    governor: input.governor ?? EMPTY_TRANSITION_GOVERNOR,
    terminal: null,
  };
}

/** A write-ahead advance: the returned record names the mutation to perform. */
export function advanceTransitionJournal(
  journal: LifecycleTransitionJournal,
  phase: TransitionPhase,
): LifecycleTransitionJournal {
  if (isTerminalPhase(journal.phase)) {
    throw new Error(
      `Cannot advance terminal transition ${journal.transitionId}`,
    );
  }
  return {
    ...advanceWriteAheadJournal(journal, phase),
    probeDeadlineAt: null,
  };
}

/**
 * Terminal records preserve the governor delta in the same object/write.  A
 * caller must never write a separate backoff file after this call.
 */
export function failTransitionJournal(input: {
  readonly journal: LifecycleTransitionJournal;
  readonly failureClass: TransitionFailureClass;
  readonly buildId: string | null;
  readonly cdHash: string | null;
  readonly now: string;
  readonly nextEligibleAt: string;
  readonly breakerAfterAttempts: number;
}): LifecycleTransitionJournal {
  return {
    ...input.journal,
    phase: "failed",
    governor: recordTransitionFailure({
      previous: input.journal.governor,
      failureClass: input.failureClass,
      buildId: input.buildId,
      cdHash: input.cdHash,
      now: input.now,
      nextEligibleAt: input.nextEligibleAt,
      breakerAfterAttempts: input.breakerAfterAttempts,
    }),
    terminal: { outcome: "failed", failureClass: input.failureClass },
  };
}

export function finishTransitionJournal(input: {
  readonly journal: LifecycleTransitionJournal;
  readonly outcome: "done" | "compensated";
  readonly now: string;
}): LifecycleTransitionJournal {
  return {
    ...input.journal,
    phase: input.outcome,
    governor: recordSustainedTransitionHealth({
      previous: input.journal.governor,
      at: input.now,
    }),
    terminal: { outcome: input.outcome, failureClass: null },
  };
}

/**
 * The canonical terminal-phase classifier. Exhaustive by construction.
 *
 * A boolean chain (what this used to be) silently answers `false` for a phase
 * it has never heard of, so adding a terminal phase upstream would quietly
 * reclassify retained journals as in-flight. The `never` guard turns that into
 * a compile error at the one place the decision belongs.
 */
export function isTerminalPhase(phase: TransitionPhase): boolean {
  switch (phase) {
    case "done":
    case "failed":
    case "compensated":
      return true;
    case "fallback-journaled":
    case "fallback-attesting-slot":
    case "fallback-provisioning":
    case "fallback-evicting-agent":
    case "fallback-committing":
    case "reclaim-probing":
    case "reclaim-awaiting-probe":
    case "reclaim-provisioning-agent":
    case "reclaim-committing-shutdown":
    case "reclaim-verifying-agent":
    case "reclaim-cleaning-fallback":
    case "reclaim-compensating-fallback":
      return false;
    default: {
      const unhandled: never = phase;
      throw new Error(`unclassified transition phase: ${String(unhandled)}`);
    }
  }
}
