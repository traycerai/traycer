import { compareHostVersions } from "../host-version/compare-host-versions";
import {
  isTerminalPhase,
  type HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";

 // It is a property of binaries already in the field.
 // So the fence is a version-floor question, not a code question.

/**
 * The value both floors carry until the release cut assigns real ones.
 * A dev version such as `0.0.0-local` is below every real release, so an unpinned floor would admit the entire fleet - including exactly the lock-blind binaries the fence exists to refuse.
 */
export const COMPATIBILITY_FLOOR_UNPINNED = "0.0.0-unpinned-at-release-cut";

export const LOCK_AWARE_CLI_FLOOR: string = COMPATIBILITY_FLOOR_UNPINNED;

export const LOCK_AWARE_DESKTOP_FLOOR: string = COMPATIBILITY_FLOOR_UNPINNED;

export interface CompatibilityFloors {
  readonly cli: string;
  readonly desktop: string;
}

/**
 * The floors production uses.
 * Every production call site passes this - never an inline literal, which is the O1 ruling's actual requirement.
 */
export const SHIPPED_COMPATIBILITY_FLOORS: CompatibilityFloors = {
  cli: LOCK_AWARE_CLI_FLOOR,
  desktop: LOCK_AWARE_DESKTOP_FLOOR,
};

export type CompatibilityRefusalReason =
  /** A floor is still the sentinel. Fail closed until the release cut pins it. */
  | "floor-unpinned"
  /** An installed CLI predates the contender lock protocol. */
  | "cli-below-floor"
  /** A Desktop build whose mutation lane writes no schema-v2 record. */
  | "desktop-below-floor"
  /**
   * A version that cannot be ordered against the floor - a `local-*` pin, a malformed string.
   * Refused rather than waived: "cannot compare" is not evidence of compliance, and the whole point of the fence is that an unverified actor is the dangerous one.
   */
  | "cli-version-incomparable"
  | "desktop-version-incomparable";

export type CompatibilityFenceVerdict =
  | { readonly kind: "admit" }
  | { readonly kind: "refuse"; readonly reason: CompatibilityRefusalReason };

export interface CompatibilityFenceInput {
  /**
   * The CLI installed beside this host, or `null` when none is recorded.
   * Refusing on absence would not close that gap - it would only refuse machines that have no installed CLI at all, which are not the dangerous ones.
   */
  readonly installedCliVersion: string | null;
  readonly desktopVersion: string;
}

/**
 * The preventive half: may a new attempt be admitted on this machine?
 * Pure and total, so the whole matrix is testable without a filesystem.
 */
export function decideCompatibilityFence(
  input: CompatibilityFenceInput,
  floors: CompatibilityFloors,
): CompatibilityFenceVerdict {
  if (
    floors.cli === COMPATIBILITY_FLOOR_UNPINNED ||
    floors.desktop === COMPATIBILITY_FLOOR_UNPINNED
  ) {
    return { kind: "refuse", reason: "floor-unpinned" };
  }
  const desktop = compareHostVersions(input.desktopVersion, floors.desktop);
  if (!desktop.comparable) {
    return { kind: "refuse", reason: "desktop-version-incomparable" };
  }
  if (desktop.ordering === "less") {
    return { kind: "refuse", reason: "desktop-below-floor" };
  }
  if (input.installedCliVersion === null) return { kind: "admit" };
  const cli = compareHostVersions(input.installedCliVersion, floors.cli);
  if (!cli.comparable) {
    return { kind: "refuse", reason: "cli-version-incomparable" };
  }
  return cli.ordering === "less"
    ? { kind: "refuse", reason: "cli-below-floor" }
    : { kind: "admit" };
}

/**
 * What the detective half does when it sees a lock-blind actor acting.
 * `park` and `terminalize` are not a severity choice - they are what the phase graph permits.
 */
export type LegacyMarkerAbortDisposition = "park" | "terminalize";

export type LegacyMarkerConcurrencyVerdict =
  | { readonly kind: "clear" }
  | {
      readonly kind: "abort";
      readonly disposition: LegacyMarkerAbortDisposition;
      /** Names the evidence. An abort whose cause is not on the record is a mystery. */
      readonly diagnostic: string;
    };

export interface LegacyMarkerConcurrencyInput {
  /** Did legacy `update-progress.json` exist at this boundary? */
  readonly legacyMarkerPresent: boolean;
  /** The live attempt's phase, or `null` when no attempt is live. */
  readonly attemptPhase: HostUpdateAttemptPhase | null;
}

/**
 * Phases at or past the restart tombstone. From here the record has promised a
 * return and cannot walk back to a park.
 */
const POST_TOMBSTONE_PHASES: ReadonlySet<HostUpdateAttemptPhase> = new Set([
  "restarting",
  "verifying",
]);

/**
 * The detective half, evaluated at a safe boundary - never mid-byte-placement.
 * Calling it during `applying`'s write window would be a caller bug, and the disposition it returns for `applying` (`park`) assumes the caller waited for the boundary rather than interrupting one.
 */
export function decideLegacyMarkerConcurrency(
  input: LegacyMarkerConcurrencyInput,
): LegacyMarkerConcurrencyVerdict {
  if (!input.legacyMarkerPresent) return { kind: "clear" };
  // No live attempt: a marker on its own is a legacy update running alone, which is the pre-cutover world working normally.
  if (input.attemptPhase === null) return { kind: "clear" };
  // A terminal record is the same case wearing a phase: complete/failed/ superseded have no legal successors, so an abort/park disposition would be unapplyable.
  if (isTerminalPhase(input.attemptPhase)) return { kind: "clear" };
  const disposition: LegacyMarkerAbortDisposition = POST_TOMBSTONE_PHASES.has(
    input.attemptPhase,
  )
    ? "terminalize"
    : "park";
  return {
    kind: "abort",
    disposition,
    diagnostic: `legacy update-progress.json observed while a schema-v2 attempt was live in phase '${input.attemptPhase}'; a lock-blind updater is mutating this host concurrently`,
  };
}

// ---- Kill switch (O4) ------------------------------------------------------

/** A downward-only cohort policy distribution, per the O4 ruling. */
export interface SignedCohortPolicy {
  readonly enabled: boolean;
  /** Verified before the policy is consulted, never after. */
  readonly signatureVerified: boolean;
  /** `true` once past its freshness bound. */
  readonly stale: boolean;
}

export type CohortPolicySource = "remote-list" | "static-default";

export interface CohortPolicyResolution {
  readonly enabled: boolean;
  readonly source: CohortPolicySource;
}

/**
 * Resolve the effective cohort policy.
 * The load-bearing property is O4 condition 3: absent, stale, or unverified input degrades **to** the static shipped default - never **through** it.
 */
export function resolveCohortPolicy(
  policy: SignedCohortPolicy | null,
  staticDefault: boolean,
): CohortPolicyResolution {
  if (policy === null || !policy.signatureVerified || policy.stale) {
    return { enabled: staticDefault, source: "static-default" };
  }
  return { enabled: policy.enabled, source: "remote-list" };
}
