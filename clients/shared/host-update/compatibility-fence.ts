import { compareHostVersions } from "../host-version/compare-host-versions";
import {
  isTerminalPhase,
  type HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";

// Ticket 07 — the compatibility fence.
//
// ## What the fence is actually for
//
// The retirement condition is "no supported lock-blind actor remains", and the
// finding that shapes everything is that **lock-blindness is not a property of
// any code we ship** — every mutating CLI command takes the contender lock on
// this tree. It is a property of binaries already in the field. So the fence is
// a VERSION-FLOOR question, not a code question.
//
// The single combination it exists for is narrow: a user-invoked **old CLI on
// `PATH`** concurrent with a new Desktop. Desktop always spawns its BUNDLED
// CLI, so a new Desktop cannot drive an old one, and the two floors move
// together as one artifact.
//
// ## Layered, per the O2 ruling — both halves are mandatory
//
// **Preventive**, at admission: the version floors below.
// **Detective**, mid-flight: legacy `update-progress.json` appearing while a
// schema-v2 attempt is live aborts the attempt at the next SAFE boundary.
//
// The `PATH`-invoked old CLI is a NAMED RESIDUAL: nothing we ship can prevent
// it, because a lock-blind CLI leaves no lock and no record to detect while it
// runs. It is detective-only, and it is retired solely by the floor rising.

/**
 * The value both floors carry until the release cut assigns real ones.
 *
 * ## Why a sentinel rather than the current dev version
 *
 * The plan said the constants land "with the current dev version". They land
 * with THIS instead, and the difference is the failure direction.
 *
 * A dev version such as `0.0.0-local` is BELOW every real release, so an
 * unpinned floor would admit the entire fleet — including exactly the
 * lock-blind binaries the fence exists to refuse. Forgetting the re-pin would
 * then be silent and fleet-wide. With this sentinel, forgetting it refuses
 * everything instead: loud, local, and impossible to mistake for working.
 *
 * That is a deliberate deviation from the plan's wording, flagged as one, and
 * it converts the one mistake nobody would notice into the one mistake nobody
 * can miss.
 *
 * ## The floors are now PINNED — this sentinel is no longer what ships
 *
 * The original text argued the sentinel "costs nothing today — both cohort
 * gates are statically disabled, so no fence verdict is consulted before
 * cutover". **That premise is false and was the reason to pin.**
 * `decideUpdateExecutorCohort` returns `{kind: "eligible"}` unconditionally
 * for every platform, so the gates are not disabled — they are OPEN, and the
 * fence that was meant to narrow them was unreachable.
 *
 * The sentinel survives as the value a NEW floor gets before it is derived,
 * and `decideCompatibilityFence` still refuses on it first, so the fail-closed
 * property is intact for anything added later.
 */
export const COMPATIBILITY_FLOOR_UNPINNED = "0.0.0-unpinned-at-release-cut";

/**
 * The release at which every actor in this repository became lock-aware.
 *
 * ONE number, three names below. The number is not invented here — it is
 * derived from the tags and recorded on the plan's release checklist
 * (`flip-and-rollout/index.md`, "Release checklist"), which carries the
 * evidence: `protocol/src/config/host-update-attempt-paths.ts`, the module
 * that defines `update-attempt.json` and the attempt lock filename, first
 * exists at `cli-v1.3.0-rc.1` and `host-v1.3.0-rc.1` and is absent at every
 * 1.2.0 tag; `clients/desktop/src/electron-main/host/` contains no
 * `update-*` or `contender` module at all at `desktop-v1.2.0`, and
 * `update-executor.ts`, `update-mutation.ts`, `update-contender.ts` and
 * `update-executor-cohort.ts` all appear together at `desktop-v1.3.0-rc.1`.
 *
 * ## Why `1.3.0-rc.1` and not `1.3.0`
 *
 * rc.1, rc.2 and rc.3 all ship the lock protocol. A `1.3.0` floor would refuse
 * three releases that are lock-aware — the exact opposite of what the floor is
 * for. `compareHostVersions` implements SemVer prerelease ordering
 * (`1.3.0-rc.1 < 1.3.0`), so pinning at the rc admits the rc's and everything
 * after, and refuses 1.2.0 and below. Measured, not assumed; the matrix is
 * pinned in `compatibility-fence.test.ts`.
 */
export const FIRST_LOCK_AWARE_RELEASE = "1.3.0-rc.1";

/** Minimum CLI version that participates in the contender lock protocol. */
export const LOCK_AWARE_CLI_FLOOR: string = FIRST_LOCK_AWARE_RELEASE;

/** Minimum Desktop version whose mutation lane writes a schema-v2 record. */
export const LOCK_AWARE_DESKTOP_FLOOR: string = FIRST_LOCK_AWARE_RELEASE;

/**
 * Minimum HOST version whose `pid.json` carries `processStartIdentity`, read
 * by Ticket 07's verify-leg fallback (Q1).
 *
 * A third NAME rather than a reuse of `LOCK_AWARE_CLI_FLOOR`, though the
 * number is the same one: that floor is about a CLI, this is about the host
 * BINARY, and the host ships from a different repository. The day those
 * numbers diverge, a host predicate reading the CLI floor would be wrong
 * silently — and a reader who met `LOCK_AWARE_CLI_FLOOR` inside a verify leg
 * comparing a host version would reasonably think it a bug. Same number, three
 * actors, one place to change it.
 */
export const HOST_START_STAMP_FLOOR: string = FIRST_LOCK_AWARE_RELEASE;

export interface CompatibilityFloors {
  readonly cli: string;
  readonly desktop: string;
}

/**
 * The floors production uses. Every production call site passes THIS — never
 * an inline literal, which is the O1 ruling's actual requirement.
 *
 * Taken as a parameter rather than read from module scope so the decision
 * function can be exercised across the full pinned matrix without mocking the
 * module. A gate that can only be tested in its shipped configuration can only
 * ever prove the shipped configuration, and the interesting behaviour here is
 * what happens once the floors ARE pinned.
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
   * A version that cannot be ordered against the floor — a `local-*` pin, a
   * malformed string. Refused rather than waived: "cannot compare" is not
   * evidence of compliance, and the whole point of the fence is that an
   * unverified actor is the dangerous one.
   */
  | "cli-version-incomparable"
  | "desktop-version-incomparable";

export type CompatibilityFenceVerdict =
  | { readonly kind: "admit" }
  | { readonly kind: "refuse"; readonly reason: CompatibilityRefusalReason };

export interface CompatibilityFenceInput {
  /**
   * The CLI installed beside this host, or `null` when none is recorded.
   *
   * `null` ADMITS, and that asymmetry is deliberate. This signal detects an
   * old *installed* CLI; it is structurally silent on one invoked from
   * elsewhere on `PATH`, which is the named residual. Refusing on absence
   * would not close that gap — it would only refuse machines that have no
   * installed CLI at all, which are not the dangerous ones.
   */
  readonly installedCliVersion: string | null;
  readonly desktopVersion: string;
}

/**
 * The preventive half: may a new attempt be admitted on this machine?
 *
 * Pure and total, so the whole matrix is testable without a filesystem. Order
 * is deliberate — the unpinned check precedes everything, because an unpinned
 * floor makes every comparison below meaningless.
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
 *
 * `park` and `terminalize` are not a severity choice — they are what the phase
 * graph permits. Before the restart tombstone an attempt can still be parked
 * and resumed. Once `restarting` is committed the record has promised a return
 * and the graph offers `{verifying, failed, superseded}` and no park at all, so
 * the only honest close is terminal-with-diagnostics. That is the amended F3
 * law applied to a different trigger, not a new rule.
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
 * The detective half, evaluated at a SAFE boundary — never mid-byte-placement.
 *
 * The caller owns "when": this function owns "what", and is pure so the matrix
 * is exhaustively testable. Calling it during `applying`'s write window would
 * be a caller bug, and the disposition it returns for `applying` (`park`)
 * assumes the caller waited for the boundary rather than interrupting one.
 */
export function decideLegacyMarkerConcurrency(
  input: LegacyMarkerConcurrencyInput,
): LegacyMarkerConcurrencyVerdict {
  if (!input.legacyMarkerPresent) return { kind: "clear" };
  // No live attempt: a marker on its own is a legacy update running alone,
  // which is the pre-cutover world working normally. There is nothing to abort
  // and nothing was mixed.
  if (input.attemptPhase === null) return { kind: "clear" };
  // A terminal record is the same case wearing a phase: complete/failed/
  // superseded have no legal successors, so an abort/park disposition would
  // be unapplyable. History beside a legacy marker is not concurrency.
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

/**
 * A downward-only cohort policy distribution, per the O4 ruling.
 *
 * Approved as NOT the forbidden "awareness transport" under four conditions,
 * and the type encodes what it can: the payload is cohort policy ONLY — no
 * per-host attempt state ever travels on this channel, in either direction.
 */
export interface SignedCohortPolicy {
  readonly enabled: boolean;
  /** Verified BEFORE the policy is consulted, never after. */
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
 *
 * The load-bearing property is O4 condition 3: absent, stale, or unverified
 * input degrades **to** the static shipped default — never **through** it. A
 * kill switch whose failure mode is "admit" is not a kill switch, and this is
 * the one function where that could go wrong silently, so every non-happy path
 * lands on the same explicit branch.
 *
 * Callers must consult this at boot/admission only, never mid-segment — the
 * same rule the static gate follows, for the same reason: a policy re-read
 * inside a held segment would abandon an adopted attempt.
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
