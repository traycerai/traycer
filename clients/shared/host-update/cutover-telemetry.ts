import {
  decideLegacyMarkerConcurrency,
  type LegacyMarkerConcurrencyInput,
} from "./compatibility-fence";
import type { HostUpdateAttemptPhase } from "@traycer/protocol/config/host-update-attempt";
import { isTerminalPhase } from "./record";

// Shadow makes the executor observable without letting it act.
// It cannot measure what happens when bytes move, because in shadow no bytes move.

export type CutoverGateId =
  | "substrate-backfill-coverage"
  | "transition-journal-health"
  | "legacy-marker-concurrency"
  | "adoption-round-trip"
  | "attempt-terminalization";

export interface GateSample {
  /** Observations collected. */
  readonly total: number;
  /** Observations that count as healthy for this gate. */
  readonly healthy: number;
}

export type GateReading =
  /** Fewer observations than the caller declared sufficient. Never "pass". */
  | { readonly kind: "insufficient-data"; readonly total: number }
  /**
   * The counts cannot describe a sample at all.
   * This one means the aggregation is broken, which resolves only when someone fixes it, and collapsing the two would hide a defect inside a status operators have been trained to wait out.
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
   * `minimumSampleSize` is required and has no default: a gate's threshold is a judgement about the fleet, and burying one here would let every caller inherit a number none of them chose.
   */
export function evaluateGate(
  sample: GateSample,
  minimumSampleSize: number,
): GateReading {
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
 * Stated as its own branch rather than a comparison against a defaulted ratio, because the whole failure mode this guards is an unknown that reads as a pass.
 */
export function gateClears(reading: GateReading, threshold: number): boolean {
  // `measured` is the only clearing arm.
  // A positive test on that one kind rather than a list of exclusions, so a future arm is non-clearing the day it is added instead of the day someone remembers to exclude it.
  return reading.kind === "measured" && reading.ratio >= threshold;
}

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

/** Gate 1 - substrate backfill coverage. */
export function isBackfillObservationHealthy(
  ownerKind: "owned" | "unknown",
): boolean {
  return ownerKind === "owned";
}

/**
 * Gate 2 - transition-journal health.
 * Both unhealthy shapes make the ownership projection fail closed, which is correct behaviour and still a reason not to enable a cohort on top of it.
 */
export function isJournalObservationHealthy(
  observation: "decoded-settled" | "decoded-in-flight" | "undecodable",
): boolean {
  return observation === "decoded-settled";
}

/**
 * Gate 3 - legacy-marker concurrency, which is also the fence's detective feed.
 * This deliberately consumes `decideLegacyMarkerConcurrency` rather than re-deriving "is this concurrent".
 */
export function isLegacyMarkerObservationHealthy(
  input: LegacyMarkerConcurrencyInput,
): boolean {
  return decideLegacyMarkerConcurrency(input).kind === "clear";
}

/**
 * Gate 4 - adoption round-trip.
 * Healthy means a minted proof was consumed exactly once.
 */
export function isAdoptionObservationHealthy(
  observation: "consumed-once" | "not-consumed" | "consumed-twice",
): boolean {
  return observation === "consumed-once";
}

/**
 * Gate 5 - attempt terminalization.
 * This is the direct measure of the stuck-updating class the whole epic exists to remove, so it consumes the canonical `isTerminalPhase` rather than listing terminals here.
 */
export function isTerminalizationObservationHealthy(
  phase: HostUpdateAttemptPhase,
): boolean {
  return isTerminalPhase(phase);
}
