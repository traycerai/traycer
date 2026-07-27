// Generated transition kill-point / disagreement fixtures for T6 (transition
// machinery). It is a generated cross product over the CLOSED phase union
// implemented by `transition/reconciler.ts`: transition type x journal phase
// x {kill, record<->actual disagreement}. `transition-kill-point.test.ts`
// consumes every row against a fresh reconciler/store boundary.

import type { TransitionPhase } from "../../transition/types";

export type SubstrateKind = "smappservice" | "raw-fallback";

export type TransitionType = "fallback" | "reclaim";

/**
 * `kill` = the transitioning process is SIGKILLed right after committing
 * this phase, before any further mutation.
 * `disagreement` = the journal names this phase but the on-disk/registration
 * state has already advanced past (or not yet reached) what the phase
 * implies — the write-ahead "accepts both pre- and post-mutation shapes"
 * rule (F2 / N5) is what must reconcile it.
 */
export type FixtureMode = "kill" | "disagreement";

export type ExpectedRecovery =
  | "forward-complete" // reconcile finishes the mutation the phase named
  | "compensate" // reconcile re-provisions the compensating registration
  | "idempotent-noop"; // already-done phase; re-running the same step is a no-op

export type TransitionKillPointCase = {
  readonly transitionType: TransitionType;
  readonly phase: TransitionPhase;
  readonly phaseIndex: number;
  readonly mode: FixtureMode;
  /** Verbatim ticket text describing what a kill at this phase leaves behind. */
  readonly killLeaves: string;
  readonly expectedRecovery: ExpectedRecovery;
  /** Whether I5 (a login-durable registration exists) must hold after this case. */
  readonly assertsI5: boolean;
};

/**
 * Fallback (smappservice -> raw), CLI or app, one-way from CLI.
 */
const FALLBACK_PHASES: readonly {
  readonly phase: TransitionPhase;
  readonly killLeaves: string;
  readonly expectedRecovery: ExpectedRecovery;
}[] = [
  {
    phase: "fallback-journaled",
    killLeaves: "agent registration intact (wedged but durable) — I5 holds",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "fallback-attesting-slot",
    killLeaves: "ditto",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "fallback-provisioning",
    killLeaves:
      "dual registration, both login-durable; I1 serializes processes",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "fallback-evicting-agent",
    killLeaves: "fallback durable — I5 holds",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "fallback-committing",
    killLeaves: "recovered by journal on next reconcile",
    expectedRecovery: "idempotent-noop",
  },
];

/**
 * Reclaim (raw -> smappservice), app-only, idle-gated. The compensation
 * branch is a genuine write-ahead phase and is generated alongside the five
 * forward-path phases.
 */
const RECLAIM_PHASES: readonly {
  readonly phase: TransitionPhase;
  readonly killLeaves: string;
  readonly expectedRecovery: ExpectedRecovery;
}[] = [
  {
    phase: "reclaim-probing",
    killLeaves:
      "raw host untouched and still the sole registration; no shutdown claimed yet — I5 holds trivially",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "reclaim-awaiting-probe",
    killLeaves:
      "probe launch is durable in the journal; a fresh reconciler consumes the one correlated marker or waits only until the recorded deadline",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "reclaim-provisioning-agent",
    killLeaves:
      "raw host still live (claim not committed, or ttl expired and admission reopened) — I5 holds",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "reclaim-committing-shutdown",
    killLeaves:
      "current-session hostless window between raw-stop and kickstart is possible (trigger-bounded, not time-bounded); next-login durability still holds because the agent plist write happens before this phase commits",
    expectedRecovery: "forward-complete",
  },
  {
    phase: "reclaim-verifying-agent",
    killLeaves:
      "agent registration durable; substrate record recovered by journal on next reconcile",
    expectedRecovery: "idempotent-noop",
  },
  {
    phase: "reclaim-cleaning-fallback",
    killLeaves:
      "agent registration durable; fallback cleanup and substrate record recover idempotently from the journal",
    expectedRecovery: "idempotent-noop",
  },
  {
    phase: "reclaim-compensating-fallback",
    killLeaves:
      "readiness failed after evicting raw; fallback re-provisioned as compensation — dual registration is the intentional, process-safe (I1) recovered state",
    expectedRecovery: "compensate",
  },
];

/**
 * The cutover plan calls out "journal present + both labels absent" as a
 * distinct, non-in-protocol fixture: external damage or inherited pre-layer
 * wreckage, not an I5 claim about how the state arose. Kept separate from
 * the generated cross product below because it deliberately does NOT assert
 * I5 the way every in-protocol case does.
 */
export const BOTH_LABELS_ABSENT_CASE: TransitionKillPointCase = {
  transitionType: "fallback",
  phase: "fallback-provisioning",
  phaseIndex: -1,
  mode: "disagreement",
  killLeaves:
    "both agent and fallback labels absent while a live journal exists — not a reachable in-protocol state",
  expectedRecovery: "compensate",
  assertsI5: false,
};

function phasesFor(transitionType: TransitionType): readonly {
  readonly phase: TransitionPhase;
  readonly killLeaves: string;
  readonly expectedRecovery: ExpectedRecovery;
}[] {
  return transitionType === "fallback" ? FALLBACK_PHASES : RECLAIM_PHASES;
}

/**
 * Generates transition type x phase x {kill, disagreement}, per the cutover
 * plan's "Migration & chaos fixtures — generated, not curated" section.
 * Every generated case (except the dedicated external-damage fixture above)
 * asserts I5.
 */
export function generateTransitionKillPointCases(): readonly TransitionKillPointCase[] {
  const cases: TransitionKillPointCase[] = [];
  for (const transitionType of ["fallback", "reclaim"] as const) {
    const phases = phasesFor(transitionType);
    phases.forEach((entry, phaseIndex) => {
      for (const mode of ["kill", "disagreement"] as const) {
        cases.push({
          transitionType,
          phase: entry.phase,
          phaseIndex,
          mode,
          killLeaves: entry.killLeaves,
          expectedRecovery: entry.expectedRecovery,
          assertsI5: true,
        });
      }
    });
  }
  return cases;
}

export function allTransitionKillPointCasesIncludingExternalDamage(): readonly TransitionKillPointCase[] {
  return [...generateTransitionKillPointCases(), BOTH_LABELS_ABSENT_CASE];
}
