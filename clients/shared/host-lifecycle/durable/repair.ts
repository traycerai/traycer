// Repair of durable-intent sentinels — plan §I2a, second half.
//
// "Proceeding past a bad record without rewriting it converts a lockout into
// an endless loop of proceeding."
//
// The direction split (§2.1.1) says a `corrupt` / `unreadable` /
// `unsupported-version` sentinel must not suppress a start. That closes the
// lockout and opens a loop, because nothing rewrites the bad bytes: `host stop`
// writes its intent, the monitor tick re-reads the *same* corrupt bytes,
// reads no refusal, and restarts — forever. The user cannot stop their host,
// and the "undo" the permissive direction is justified by is exactly the
// mechanism that is broken.
//
// `DurableIntentEffect` has `set-` / `clear-` / `preserve-` arms and no arm
// that says "these bytes are wrong; replace them". This module supplies that
// arm — `repair-canonical` — plus the single canonical encoder its actuator
// writes, so there is exactly one definition of "canonical shape" and it is
// the shape `decodeBooleanSentinel` accepts under *either* sentinel key.
//
// Scope, stated rather than implied: this covers the two boolean sentinels.
// §I2a asks for one repair effect covering versioned *records* too, and that
// is deliberately not here — "canonical shape" is not derivable for a record
// whose bytes we could not decode (rewriting an `unsupported-version`
// `install.json` to our own v1 destroys a newer writer's state, and a corrupt
// `install.json` has no reconstructible content). Record repair needs a
// remove/reconstruct disposition and its own decision; this arm does not
// silently pretend to cover it.

import type { Evidence } from "../evidence";
import type { BooleanSentinelKey } from "./sentinel";

/** Durable files `repair-canonical` can rewrite. */
export type DurableRepairTarget = "removed-by-user" | "stopped-by-user";

/**
 * What the decode said *before* the repair. One arm per decode verdict, so
 * evidence still travels (I3): doctor can say "your stop sentinel was corrupt
 * and has been rewritten", not just "rewritten".
 *
 * `indeterminate` is the arm for a platform-specific indeterminate cause that
 * did not originate in `booleanSentinelToEvidence` — reported honestly rather
 * than folded into `corrupt`, which would be a decoder verdict we never made.
 */
export type DurableRepairPriorDecode =
  | "observed"
  | "absent"
  | "corrupt"
  | "unreadable"
  | "unsupported-version"
  | "indeterminate";

/**
 * The missing `DurableIntentEffect` arm.
 *
 * Semantics: **write `value` to `target` in canonical shape**, replacing
 * whatever bytes are there. It supersedes `set-` / `clear-` for the sentinel an
 * intent establishes — `set-stopped-by-user` says *what* to persist but not
 * that a wrong-shaped file must stop being wrong-shaped — and it replaces
 * `preserve-` wherever preserving would leave a fault on disk that the next
 * tick re-reads.
 *
 * It is emitted for the sentinel the intent **establishes** (`stop` →
 * stopped-by-user := true, `restart` → stopped-by-user := false, `remove` →
 * removed-by-user := true), on every prior decode including `observed` — an
 * unconditional rewrite is what makes the arm total, and re-writing an already
 * canonical file is a no-op the user never sees. It is **not** emitted for a
 * sentinel the intent does not establish: writing a fabricated value into the
 * file recording a *different* user decision is the same fall-through-to-a-
 * value the decoder is forbidden from doing, one layer up.
 */
export type RepairCanonicalEffect = {
  readonly kind: "repair-canonical";
  readonly target: DurableRepairTarget;
  readonly value: boolean;
  readonly priorDecode: DurableRepairPriorDecode;
};

/** The version `canonicalBooleanSentinelBytes` stamps. */
export const CANONICAL_BOOLEAN_SENTINEL_VERSION = 1;

/**
 * The one encoder. Emits `{ v, value, <the target's own legacy key> }` — the
 * same fact twice, on purpose.
 *
 * **The legacy key is a compatibility measure with a defined end, not part of
 * the schema.** The removed-by-user sentinel has a second, still-shipping
 * reader: `clients/desktop/src/electron-main/host/host-removal-state.ts`
 * recognises only `removedByUser === true` and cannot read a `{v,value}`
 * envelope at all. Measured against that real reader, a bare envelope means
 * `remove` writes the user's decision and the desktop's own
 * `isHostRemovedByUser()` reads back **false** — so the host the user just
 * removed is reinstalled at the next login. That is the resurrect direction on
 * the one sentinel where the permissive direction is *not* cheap.
 *
 * **Drop the legacy key once the shipped desktop reader understands the
 * envelope** — that is the whole condition. It is pinned in both directions by
 * `host-removal-state-sentinel-contract.test.ts` (real writer → this decoder,
 * and this encoder → the real shipped reader); when the reader is updated,
 * delete the key here and that test tells you whether you were right.
 *
 * Uniform over both sentinels rather than special-cased to removed-by-user: a
 * special case is what someone deletes in two years as obviously redundant.
 *
 * The output decodes to `observed(value)` at the target's **own** key, and to
 * `corrupt` at the other one — a repaired file copied to the wrong path is
 * unattributable, which is the cross-sentinel rule doing its job. That is the
 * property the round-trip test pins, and it is what makes the arm a fixed
 * point: repairing twice changes nothing.
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

/** Which key/file a repair target names, for the actuator and for doctor. */
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
 * `true` when leaving these bytes in place makes the fault permanent — i.e.
 * every subsequent tick re-reads the same unusable file.
 *
 * Only meaningful for the sentinel an intent establishes; there is no safe
 * repair for a faulted sentinel nobody is acting on (see
 * `RepairCanonicalEffect`).
 */
export function sentinelDecodeIsFaulted(
  current: Evidence<boolean, string>,
): boolean {
  return current.kind === "indeterminate";
}

/** Build the effect. Total: an establishing intent always rewrites. */
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
 * Evidence line for a repair (I3). Returned as a string so this module stays
 * below the planner and never imports `ActionEvidence`; the planner wraps it
 * with `source: "durable"`.
 */
export function repairCanonicalVerdict(effect: RepairCanonicalEffect): string {
  return `${effect.target} rewritten to canonical ${String(effect.value)} (prior decode: ${effect.priorDecode})`;
}
