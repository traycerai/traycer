// Durable-intent sentinels (`removedByUser` / `stoppedByUser`) - macOS annex §2.1.1, shared by all three platforms.
// The decoder is therefore total over the bytes on disk and **may not fall through to a value**: an unrecognised shape is `corrupt`, never `observed(true)`.

import type { Evidence } from "../evidence";
import type { DurableBytes } from "./decoder";

export type BooleanSentinelKey = "removedByUser" | "stoppedByUser";

/** Closed set of per-file legacy payload keys, for cross-sentinel rejection. */
const SENTINEL_KEYS: readonly BooleanSentinelKey[] = [
  "removedByUser",
  "stoppedByUser",
];

/**
 * Decode verdict for a boolean sentinel file. Mirrors `DurableRecord` minus
 * the version payload - the value is the boolean itself (annex §2.1.1).
 */
export type BooleanSentinelRecord =
  | { readonly kind: "observed"; readonly value: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "unsupported-version"; readonly version: number };

export const BOOLEAN_SENTINEL_SUPPORTED_VERSIONS: readonly number[] = [1];

/**
 * Total decode of a boolean sentinel file (annex §2.1.1 shape table), read **for a named sentinel**.
 * Three rules do the keying work, and all are in the restrictive→`corrupt` direction, which under the direction split means *proceed and repair*, never a new way to be locked out: 1.
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

  // Rule 2 - cross-sentinel attribution. Checked before the version gate so a
  // mis-keyed file cannot ride in on a supported envelope either.
  for (const key of SENTINEL_KEYS) {
    if (key !== expectedKey && obj[key] !== undefined) {
      return { kind: "corrupt" };
    }
  }

  // Rule 3 - self-agreement.
  // A record that disagrees with itself is unattributable - the same principle as Rule 2 - so it is `corrupt` rather than resolved by whichever key the reader happens to check first.
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

  // A declared version is checked before the payload so an N+1 writer's shape is reported as `unsupported-version`, not guessed at (mixed-version protocol: new actors treat it as its own planner input).
  const versionRaw = obj.v ?? obj.version;
  if (versionRaw !== undefined) {
    if (typeof versionRaw !== "number" || !Number.isInteger(versionRaw)) {
      return { kind: "corrupt" };
    }
    if (!BOOLEAN_SENTINEL_SUPPORTED_VERSIONS.includes(versionRaw)) {
      return { kind: "unsupported-version", version: versionRaw };
    }
    // Rule 1 - a supported version pins the payload to the canonical key.
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

export type SentinelIndeterminateCause =
  | "sentinel-corrupt"
  | "sentinel-unreadable"
  | "sentinel-unsupported-version";

  /**
   * Project a sentinel decode onto an `Evidence<boolean>` world field.
   * `observed`/`absent` pass through; every failed arm becomes `indeterminate` with its own cause - **never** a value.
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
