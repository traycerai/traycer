import {
  decideLegacyMarkerConcurrency,
  type LegacyMarkerConcurrencyInput,
} from "./compatibility-fence";
import type { HostUpdateAttemptPhase } from "@traycer/protocol/config/host-update-attempt";
import { isTerminalPhase } from "./record";

// Ticket 07 §4.2 — the shadow/telemetry gates that must read healthy before any
// cohort is enabled.
//
// ## What shadow mode can and cannot tell us
//
// Shadow makes the executor observable without letting it act. It can measure
// which code paths are reached and the SHAPE of decisions. It cannot measure
// what happens when bytes move, because in shadow no bytes move. So these gates
// are necessary and none of them is sufficient — the packaging probe is the
// other half, and it is the one that observes rather than argues.
//
// ## The one property every gate here shares
//
// **No samples is not a passing grade.** A ratio over an empty denominator is
// not 0%, it is unknown, and an "unknown" that renders as "0 failures" is how a
// gate certifies a fleet it never observed. Every reading below is therefore a
// three-arm result with an explicit `insufficient-data`, and the minimum sample
// size is an input rather than a constant so the caller states what it thinks
// is enough instead of inheriting a number nobody chose.

export type CutoverGateId =
  | "substrate-backfill-coverage"
  | "transition-journal-health"
  | "legacy-marker-concurrency"
  | "adoption-round-trip"
  | "attempt-terminalization";

export interface GateSample {
  /** Observations collected. */
  readonly total: number;
  /** Observations that count as HEALTHY for this gate. */
  readonly healthy: number;
}

export type GateReading =
  /** Fewer observations than the caller declared sufficient. Never "pass". */
  | { readonly kind: "insufficient-data"; readonly total: number }
  /**
   * The counts cannot describe a sample at all.
   *
   * Kept DISTINCT from `insufficient-data`, which is an honest "not enough
   * evidence yet" - a routine state that resolves on its own. This one means
   * the aggregation is broken, which resolves only when someone fixes it, and
   * collapsing the two would hide a defect inside a status operators have been
   * trained to wait out.
   */
  | { readonly kind: "malformed"; readonly defect: GateSampleDefect }
  | {
      readonly kind: "measured";
      /** Healthy fraction in `[0, 1]`. */
      readonly ratio: number;
      readonly total: number;
    };

export type GateSampleDefect =
  /** `NaN`, `Infinity`, or a fraction where a count belongs. */
  | "not-a-count"
  | "negative"
  /** More healthy observations than observations. */
  | "healthy-exceeds-total";

/**
 * Turn counts into a reading, or refuse to.
 *
 * `minimumSampleSize` is required and has no default: a gate's threshold is a
 * judgement about the fleet, and burying one here would let every caller
 * inherit a number none of them chose.
 */
export function evaluateGate(
  sample: GateSample,
  minimumSampleSize: number,
): GateReading {
  // Validity BEFORE sufficiency: a malformed count cannot be compared to a
  // minimum in the first place - `NaN` is neither above nor below any
  // threshold - and letting one reach the ratio is what produced the
  // reviewer's probe, where `{total: 10, healthy: 11}` returned `ratio: 1.1`
  // and CLEARED a 0.99 gate, certifying a cutover on an aggregation defect.
  const defect = sampleDefect(sample);
  if (defect !== null) return { kind: "malformed", defect };
  if (sample.total < minimumSampleSize || sample.total === 0) {
    return { kind: "insufficient-data", total: sample.total };
  }
  return {
    kind: "measured",
    ratio: sample.healthy / sample.total,
    total: sample.total,
  };
}

/**
 * Does a reading clear a threshold?
 *
 * `insufficient-data` is NOT clear. Stated as its own branch rather than a
 * comparison against a defaulted ratio, because the whole failure mode this
 * guards is an unknown that reads as a pass.
 */
export function gateClears(reading: GateReading, threshold: number): boolean {
  // `measured` is the ONLY clearing arm. A positive test on that one kind
  // rather than a list of exclusions, so a future arm is non-clearing the day
  // it is added instead of the day someone remembers to exclude it.
  return reading.kind === "measured" && reading.ratio >= threshold;
}

/** `null` when the counts can describe a sample. */
function sampleDefect(sample: GateSample): GateSampleDefect | null {
  for (const value of [sample.total, sample.healthy]) {
    if (!Number.isInteger(value)) return "not-a-count";
    if (value < 0) return "negative";
  }
  // `Number.isInteger` already excluded `NaN` and both infinities, so the only
  // remaining impossibility is the relationship between the two counts.
  return sample.healthy > sample.total ? "healthy-exceeds-total" : null;
}

// ---- Per-gate observation shaping -----------------------------------------

/**
 * Gate 1 — substrate backfill coverage.
 *
 * Healthy means the owner projection named a CONCRETE owner. `unknown` is the
 * measured quantity, and it is the number that blocks the
 * `isPackagedMacOwned()` repoint: repointing while `unknown` is common converts
 * working-but-unattested machines into ones where every maintenance surface
 * fails closed.
 */
export function isBackfillObservationHealthy(
  ownerKind: "owned" | "unknown",
): boolean {
  return ownerKind === "owned";
}

/**
 * Gate 2 — transition-journal health.
 *
 * Healthy means the journal decoded AND was not in-flight at boot. Both
 * unhealthy shapes make the ownership projection fail closed, which is correct
 * behaviour and still a reason not to enable a cohort on top of it.
 */
export function isJournalObservationHealthy(
  observation: "decoded-settled" | "decoded-in-flight" | "undecodable",
): boolean {
  return observation === "decoded-settled";
}

/**
 * Gate 3 — legacy-marker concurrency, which is ALSO the fence's detective feed.
 *
 * This deliberately CONSUMES `decideLegacyMarkerConcurrency` rather than
 * re-deriving "is this concurrent". Two copies of that judgement is the
 * second-copy-of-a-policy class this epic has already paid for twice, and it
 * would be especially bad here: the telemetry number and the abort decision
 * would diverge, so the fleet metric would say clear while attempts were being
 * aborted in the field.
 */
export function isLegacyMarkerObservationHealthy(
  input: LegacyMarkerConcurrencyInput,
): boolean {
  return decideLegacyMarkerConcurrency(input).kind === "clear";
}

/**
 * Gate 4 — adoption round-trip.
 *
 * Healthy means a minted proof was consumed exactly once. `not-consumed` and
 * `consumed-twice` are different failures — a proof nobody consumed means the
 * producer half is unreachable, a proof consumed twice means the one-shot
 * property broke — and both are unhealthy, so the gate does not need to rank
 * them. The diagnostic distinction lives with the observation, not the ratio.
 */
export function isAdoptionObservationHealthy(
  observation: "consumed-once" | "not-consumed" | "consumed-twice",
): boolean {
  return observation === "consumed-once";
}

/**
 * Gate 5 — attempt terminalization.
 *
 * Healthy means the attempt reached a terminal phase. This is the direct
 * measure of the stuck-updating class the whole epic exists to remove, so it
 * consumes the canonical `isTerminalPhase` rather than listing terminals here.
 */
export function isTerminalizationObservationHealthy(
  phase: HostUpdateAttemptPhase,
): boolean {
  return isTerminalPhase(phase);
}
