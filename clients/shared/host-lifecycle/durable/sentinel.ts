// Durable-intent sentinels (`removedByUser` / `stoppedByUser`) — macOS annex
// §2.1.1, shared by all three platforms.
//
// These files are durable *refusals to start*. Getting them wrong in the
// permissive direction costs one unwanted host start, which the user can see
// and undo. Getting them wrong in the restrictive direction is a silent
// lockout with no diagnosis — the v1.1.7/v1.1.8 failure this epic exists to
// remove. The decoder is therefore total over the bytes on disk and **may not
// fall through to a value**: an unrecognised shape is `corrupt`, never
// `observed(true)`.
//
// The decoder is **keyed** (rev 8). `observed(true)` is the only verdict that
// suppresses a start, so every shape that reaches it is load-bearing. A
// decoder that accepts *any* known sentinel key on *any* sentinel file lets a
// stray or mis-keyed `{"stoppedByUser":true}` sitting at the removed-by-user
// path decode as "the user removed Traycer" — silently preventing the host
// from ever running, from a file no writer in either repo produces at that
// path. Cross-sentinel and mixed shapes are corrupt, and `corrupt` proceeds
// (and is repaired — see `./repair`).

import type { Evidence } from "../evidence";
import type { DurableBytes } from "./decoder";

/**
 * Which sentinel file is being decoded. The decoder needs this: the accepted
 * legacy payload key is per-file, and the *other* file's key appearing here is
 * evidence of a mis-written or stray file, not of a user decision.
 */
export type BooleanSentinelKey = "removedByUser" | "stoppedByUser";

/** Closed set of per-file legacy payload keys, for cross-sentinel rejection. */
const SENTINEL_KEYS: readonly BooleanSentinelKey[] = [
  "removedByUser",
  "stoppedByUser",
];

/**
 * Decode verdict for a boolean sentinel file. Mirrors `DurableRecord` minus
 * the version payload — the value is the boolean itself (annex §2.1.1).
 */
export type BooleanSentinelRecord =
  | { readonly kind: "observed"; readonly value: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "unsupported-version"; readonly version: number };

/** Versions of the canonical `{ v, value }` envelope this decoder accepts. */
export const BOOLEAN_SENTINEL_SUPPORTED_VERSIONS: readonly number[] = [1];

/**
 * Total decode of a boolean sentinel file (annex §2.1.1 shape table), read
 * **for a named sentinel**.
 *
 * | Bytes                                            | at its own key | at the other key |
 * |--------------------------------------------------|----------------|------------------|
 * | `{"v":1,"value":true,"removedByUser":true}`      | `observed(true)`  | **`corrupt`**    |
 * | `{"v":1,"value":true}`                           | `observed(true)`  | `observed(true)` |
 * | `{"value":<bool>}`                               | `observed(<bool>)`| `observed(<bool>)` |
 * | `{"removedByUser":false}`                        | `observed(false)` | **`corrupt`**    |
 * | `{"stoppedByUser":true}`                         | `observed(true)`  | **`corrupt`**    |
 * | `{"v":1,"removedByUser":true}`                   | **`corrupt`**     | **`corrupt`**    |
 * | `{"v":1,"value":true,"removedByUser":false}`     | **`corrupt`**     | **`corrupt`**    |
 * | bare `true` / `false`                            | `observed(<bool>)`| `observed(<bool>)` |
 * | `{"v":<unsupported>, …}`                         | `unsupported-version` | same         |
 * | any other JSON                                   | `corrupt`         | `corrupt`        |
 * | unparseable                                      | `corrupt`         | `corrupt`        |
 * | IO error                                         | `unreadable`      | `unreadable`     |
 * | no file                                          | `absent`          | `absent`         |
 *
 * The first row is what `./repair` writes. Three rules do the keying work, and
 * all are in the restrictive→`corrupt` direction, which under the direction
 * split means *proceed and repair*, never a new way to be locked out:
 *
 * 1. **A declared, supported version pins the payload to `value`.** `v:1` names
 *    the canonical envelope; `{"v":1,"removedByUser":true}` is a shape no
 *    writer emits — a versioned envelope carrying an unversioned-era key — so
 *    it is corrupt rather than half-honoured.
 * 2. **The other sentinel's key present at all ⇒ corrupt.** Not merely "not
 *    consulted": its presence says these bytes were written for a different
 *    file, and the only safe reading of a file we cannot attribute is that we
 *    could not read it.
 * 3. **A record that disagrees with itself ⇒ corrupt.** `value` and the file's
 *    own legacy key both carry the fact; if they contradict, neither wins.
 *
 * `value` stays accepted unversioned because it is the canonical payload key
 * and is not attributable to either file specifically.
 */
export function decodeBooleanSentinel(
  input: DurableBytes,
  expectedKey: BooleanSentinelKey,
): BooleanSentinelRecord {
  if (input.kind === "missing") {
    return { kind: "absent" };
  }
  if (input.kind === "unreadable") {
    return { kind: "unreadable", cause: input.cause };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { kind: "corrupt" };
  }

  if (typeof parsed === "boolean") {
    return { kind: "observed", value: parsed };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }

  const obj = parsed as Record<string, unknown>;

  // Rule 2 — cross-sentinel attribution. Checked before the version gate so a
  // mis-keyed file cannot ride in on a supported envelope either.
  for (const key of SENTINEL_KEYS) {
    if (key !== expectedKey && obj[key] !== undefined) {
      return { kind: "corrupt" };
    }
  }

  // Rule 3 — self-agreement. The canonical envelope deliberately carries the
  // same fact twice (`value` plus the file's own legacy key, so the shipped
  // desktop reader can still read it — see `./repair`). Two encodings of one
  // fact can therefore contradict each other, which the encoder never does but
  // a torn write or a hand edit does: `{"v":1,"value":true,"removedByUser":false}`
  // is the shape that arrives from a half-written file. A record that disagrees
  // with itself is unattributable — the same principle as Rule 2 — so it is
  // `corrupt` rather than resolved by whichever key the reader happens to check
  // first. A present-but-non-boolean own key is equally unattributable.
  const ownKey = obj[expectedKey];
  if (ownKey !== undefined && obj.value !== undefined) {
    if (
      typeof ownKey !== "boolean" ||
      typeof obj.value !== "boolean" ||
      ownKey !== obj.value
    ) {
      return { kind: "corrupt" };
    }
  }

  // A declared version is checked before the payload so an N+1 writer's shape
  // is reported as `unsupported-version`, not guessed at (mixed-version
  // protocol: new actors treat it as its own planner input).
  const versionRaw = obj.v ?? obj.version;
  if (versionRaw !== undefined) {
    if (typeof versionRaw !== "number" || !Number.isInteger(versionRaw)) {
      return { kind: "corrupt" };
    }
    if (!BOOLEAN_SENTINEL_SUPPORTED_VERSIONS.includes(versionRaw)) {
      return { kind: "unsupported-version", version: versionRaw };
    }
    // Rule 1 — a supported version pins the payload to the canonical key.
    if (typeof obj.value !== "boolean") {
      return { kind: "corrupt" };
    }
    return { kind: "observed", value: obj.value };
  }

  if (typeof obj.value === "boolean") {
    return { kind: "observed", value: obj.value };
  }
  const legacy = obj[expectedKey];
  if (typeof legacy === "boolean") {
    return { kind: "observed", value: legacy };
  }

  return { kind: "corrupt" };
}

/**
 * Causes a failed sentinel decode contributes to a platform's indeterminate
 * union. Distinct per arm so evidence still travels (I3) — doctor can tell a
 * user *why* the sentinel could not be read (annex §2.1.1, "Where the
 * non-`observed(true)` arms land, precisely").
 */
export type SentinelIndeterminateCause =
  "sentinel-corrupt" | "sentinel-unreadable" | "sentinel-unsupported-version";

/**
 * Project a sentinel decode onto an `Evidence<boolean>` world field.
 * `observed`/`absent` pass through; every failed arm becomes `indeterminate`
 * with its own cause — **never** a value.
 *
 * The result assigns to any platform `Evidence<boolean, PlatformCause>` whose
 * cause union includes `SentinelIndeterminateCause`, so each platform keeps
 * its own closed cause set without a cast.
 */
export function booleanSentinelToEvidence(
  record: BooleanSentinelRecord,
): Evidence<boolean, SentinelIndeterminateCause> {
  if (record.kind === "observed") {
    return { kind: "observed", value: record.value };
  }
  if (record.kind === "absent") {
    return { kind: "absent" };
  }
  if (record.kind === "corrupt") {
    return { kind: "indeterminate", cause: "sentinel-corrupt" };
  }
  if (record.kind === "unreadable") {
    return { kind: "indeterminate", cause: "sentinel-unreadable" };
  }
  return { kind: "indeterminate", cause: "sentinel-unsupported-version" };
}
