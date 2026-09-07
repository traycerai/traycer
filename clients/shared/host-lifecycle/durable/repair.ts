// Repair of durable-intent sentinels - plan §I2a, second half.
// The user cannot stop their host, and the "undo" the permissive direction is justified by is exactly the mechanism that is broken.

import type { Evidence } from "../evidence";
import type { BooleanSentinelKey } from "./sentinel";

export type DurableRepairTarget = "removed-by-user" | "stopped-by-user";

export type DurableRepairPriorDecode =
  | "observed"
  | "absent"
  | "corrupt"
  | "unreadable"
  | "unsupported-version"
  | "indeterminate";

export type RepairCanonicalEffect = {
  readonly kind: "repair-canonical";
  readonly target: DurableRepairTarget;
  readonly value: boolean;
  readonly priorDecode: DurableRepairPriorDecode;
};

export const CANONICAL_BOOLEAN_SENTINEL_VERSION = 1;

/**
 * The one encoder.
 * **Drop the legacy key once the shipped desktop reader understands the envelope** - that is the whole condition.
 */
export function canonicalBooleanSentinelBytes(
  target: DurableRepairTarget,
  value: boolean,
): string {
  return `${JSON.stringify({
    v: CANONICAL_BOOLEAN_SENTINEL_VERSION,
    value,
    [repairTargetSentinelKey(target)]: value,
  })}\n`;
}

export function repairTargetSentinelKey(
  target: DurableRepairTarget,
): BooleanSentinelKey {
  return target === "removed-by-user" ? "removedByUser" : "stoppedByUser";
}

/**
 * Classify the pre-repair decode from the world's evidence field. Total, and
 * never invents a decode verdict it did not see.
 */
export function sentinelPriorDecode(
  current: Evidence<boolean, string>,
): DurableRepairPriorDecode {
  if (current.kind === "observed") return "observed";
  if (current.kind === "absent") return "absent";
  if (current.cause === "sentinel-corrupt") return "corrupt";
  if (current.cause === "sentinel-unreadable") return "unreadable";
  if (current.cause === "sentinel-unsupported-version") {
    return "unsupported-version";
  }
  return "indeterminate";
}

/**
 * `true` when leaving these bytes in place makes the fault permanent - i.e. every subsequent tick re-reads the same unusable file.
 * Only meaningful for the sentinel an intent establishes; there is no safe repair for a faulted sentinel nobody is acting on (see `RepairCanonicalEffect`).
 */
export function sentinelDecodeIsFaulted(
  current: Evidence<boolean, string>,
): boolean {
  return current.kind === "indeterminate";
}

export function repairCanonical(
  target: DurableRepairTarget,
  value: boolean,
  current: Evidence<boolean, string>,
): RepairCanonicalEffect {
  return {
    kind: "repair-canonical",
    target,
    value,
    priorDecode: sentinelPriorDecode(current),
  };
}

/**
 * Evidence line for a repair (I3).
 * Returned as a string so this module stays below the planner and never imports `ActionEvidence`; the planner wraps it with `source: "durable"`.
 */
export function repairCanonicalVerdict(effect: RepairCanonicalEffect): string {
  return `${effect.target} rewritten to canonical ${String(effect.value)} (prior decode: ${effect.priorDecode})`;
}
