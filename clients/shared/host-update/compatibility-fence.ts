import { compareHostVersions } from "../host-version/compare-host-versions";
import {
  nonReleaseIdentityKind,
  type NonReleaseIdentityKind,
} from "../host-version/non-release-identity";
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
//
// ## The residual, stated as protection the user actually has
//
// What an already-shipped binary does when it runs is physically outside any
// patch in this repository, and it is worth saying what remains rather than
// implying a constant closes it.
//
// A CLI at 1.0.0-1.1.11 consults NO floor of ours. `requiredCliVersion` is
// parse-only in every one of those releases ("Intentionally parse-only ... do
// not act on it"), so even a manifest that floors the cutover is ignored by
// them, and the floors pinned below are not in their binaries to read. Those
// versions install whatever the registry offers, silently. That is the whole
// fleet below 1.2.0.
//
// So the protection is layered and each layer has a real edge:
//
//  1. `requiredCliVersion` in the PUBLISHED MANIFEST, enforced by
//     `evaluateHostClientFloor` (`registry/client-floor.ts`, called inside
//     `resolveAsset`, so `install` and `download-stage` both pass through it).
//     This is the only lever that can refuse an old CLI at all, it is
//     publisher policy rather than a shipped constant, and it bites 1.2.0 and
//     later ONLY.
//  2. Below 1.2.0: the preventive fence here, which refuses a NEW attempt on a
//     machine whose installed CLI is below the floor — but only where a
//     Desktop exists to ask, and it cannot see a CLI invoked from elsewhere on
//     `PATH`.
//  3. Below that: evidence. A lock-blind run leaves the legacy marker and its
//     own install record, which is what the detective half is for and what
//     recovery reconciles afterwards.
//
// Nothing in this list refuses a 1.0.0 CLI invoked by hand on a machine with
// no Desktop. That case is closed by the fleet aging past the floor and by
// nothing else, and a release that needs it closed sooner needs a published
// manifest floor, not a code change here.

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
 * Minimum HOST version whose `pid.json` carries a usable
 * `processStartIdentity`, read by Ticket 07's verify-leg fallback (Q1).
 *
 * ## It is NOT `FIRST_LOCK_AWARE_RELEASE`, and that is the point of the name
 *
 * The first derivation of this constant took the lock module's presence at
 * each tag and landed on `1.3.0-rc.1`. That floors LOCK-AWARENESS — a
 * different property, of a different code path, in a different repository —
 * and the coincidence of a plausible number with wrong reasoning is worse
 * than a wrong number, because the next person re-deriving inherits it. The
 * real floor is **two minor lines lower**, so a fence that had reused the CLI
 * floor here would have forced version-only verification on every 1.1.9
 * through 1.3.0 host that could in fact prove its identity.
 *
 * ## Derivation (Q14)
 *
 * The WRITER's history, not the reader's verdict:
 *
 *  - the three `format*ProcessStartIdentity` functions first exist at
 *    `host-v1.1.9` — `protocol/src/host/lifecycle/process-start-identity.ts`
 *    is absent at `host-v1.1.8` — matching internal #4655 (2026-07-28) in
 *    `pid-metadata.ts` / `layer0-lock.ts`;
 *  - raw `pid.json` readings on BOTH platforms: 1.1.11 (raw), 1.2.0
 *    (projection) and 1.3.0-rc.3 (production raw) all carry the field;
 *    1.0.0, 1.1.5 and 1.1.8 do not. The boundary brackets `host-v1.1.9`
 *    exactly.
 *
 * **No platform split.** Linux was the candidate for one —
 * `formatLinuxProcessStartIdentity` has required a boot id
 * (`/proc/sys/kernel/random/boot_id`) since 1.1.9 and returns `null` for an
 * unreadable one, where macOS needs only `ps -o lstart=` — but the readings
 * agree across both, so one constant is honest here. If that ever stops being
 * true this must become the max across platforms or platform-aware, because
 * the identity is platform-TAGGED and "does this version write a usable
 * stamp" is a per-platform question by construction.
 *
 * ## Read RAW bytes when re-deriving, never the reader's verdict
 *
 * `isProcessStartIdentity` rejects an untagged token, an unknown platform tag
 * and an empty payload, and the pid-metadata decoder maps every rejection to
 * `null` — the same value absence produces. So three states collapse into one
 * at the reader: key absent, key present but rejected, key present and valid.
 * The floor is the first release where the THIRD holds; deriving from the
 * reader's `null` puts it too LOW wherever the middle state exists. (Reviewer
 * C, Q8 review.)
 *
 * ## Error direction
 *
 * Too HIGH only degrades an already-stamped target to version-only
 * verification, and the record says it did. Too LOW reproduces Q1 as a hard
 * failure on every rollback into the band. **Err high.**
 *
 * ## Which of the two numbers SHIPS, and why it is the higher one
 *
 * Source history says `1.1.9`; raw readings prove `1.1.11`. The 1.1.9 and
 * 1.1.10 rows have not run, so that band is inferred, not observed — and it is
 * exactly the band where being wrong is the bad direction. A target there
 * treated as at-or-above the floor keeps the identity check MANDATORY, so if
 * those releases turn out not to stamp, Q1 reproduces as a hard failure on
 * every rollback into them. Shipping `1.1.11` instead costs those two releases
 * NOTHING if they stamp — the arm is gated on the evidence, not on this
 * constant — and a recorded version-only verification if they do not.
 *
 * So the SHIPPED floor is the proven one. `HOST_START_STAMP_WRITER_FLOOR`
 * below carries the writer-history value with its evidence, and replaces this
 * the moment the Linux 1.1.9/1.1.10 rows land.
 */
export const HOST_START_STAMP_FLOOR: string = "1.1.11";

/**
 * The lowest host version whose stamp has been OBSERVED in a raw `pid.json`.
 *
 * The invariant the suite pins: the SHIPPED floor is never below this. A floor
 * under the proven line is a claim that a version stamps when nobody has seen
 * it do so, and that claim fails in the Q1 direction — mandatory identity
 * verification against a host that cannot supply an identity.
 */
export const HOST_START_STAMP_PROVEN_FLOOR = "1.1.11";

/**
 * The writer's first tag, from source history: `host-v1.1.9`, where the three
 * `format*ProcessStartIdentity` functions first exist (absent at 1.1.8) and
 * where internal #4655 landed in `pid-metadata.ts` / `layer0-lock.ts`.
 *
 * Not shipped, and the distinction is the point rather than bookkeeping.
 * Source history says a version CAN write the stamp; a raw reading says one
 * DID. Between them sit the failure modes source cannot see — a writer that
 * calls the formatter with an argument it cannot obtain (Linux's boot id), or
 * one that writes a shape today's reader rejects, which the pid-metadata
 * decoder reports as `null` indistinguishably from absence.
 *
 * This becomes `HOST_START_STAMP_FLOOR` when the Linux 1.1.9/1.1.10 rows land
 * and prove it. Until then it is evidence, not a floor.
 */
export const HOST_START_STAMP_WRITER_FLOOR = "1.1.9";

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

/**
 * A non-release build admitted without an ordering comparison, recorded so the
 * waiver is evidence rather than silence.
 *
 * Every admit carries this list, EMPTY when both actors were really compared.
 * Recording positively rather than "present only when waived" is deliberate
 * and is the same rule Ticket 07's `verification` key settled on: a field that
 * exists only in the exceptional case makes absence load-bearing, and then a
 * writer that forgets is indistinguishable from one that had nothing to say.
 */
export interface NonReleaseAdmission {
  readonly actor: "cli" | "desktop";
  readonly version: string;
  readonly identity: NonReleaseIdentityKind;
}

export type CompatibilityFenceVerdict =
  | {
      readonly kind: "admit";
      /** Empty when every actor was ordered against its floor. */
      readonly waived: readonly NonReleaseAdmission[];
    }
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
  const waived: NonReleaseAdmission[] = [];
  const desktop = actorVerdict(
    "desktop",
    input.desktopVersion,
    floors.desktop,
    waived,
  );
  if (desktop !== null) return desktop;
  if (input.installedCliVersion !== null) {
    const cli = actorVerdict(
      "cli",
      input.installedCliVersion,
      floors.cli,
      waived,
    );
    if (cli !== null) return cli;
  }
  return { kind: "admit", waived };
}

/**
 * One actor against its floor: a refusal, or `null` meaning "this actor is
 * fine" — having appended a waiver to `waived` if it was admitted without a
 * comparison.
 *
 * ## The two non-release branches, which are NOT one branch
 *
 * A naive fence handles "incomparable" and believes it has covered dev and
 * staging builds. It has not, and the gap is silent:
 *
 *  - `staging.<epoch>.<sha>` and `local-<basename>-<stamp>` are not SemVer at
 *    all, so they land on INCOMPARABLE;
 *  - `0.0.0-local` **is** valid SemVer and sorts below every release, so it
 *    lands on BELOW-FLOOR — a different arm, which an incomparable-only rule
 *    never reaches.
 *
 * Both are builds of a lock-aware tree by construction, and both must be
 * admitted, or the fence refuses the staging builds the cutover matrix itself
 * runs on — a red matrix caused by the fix. So the recognizer runs FIRST, over
 * an enumerated set of shapes, ahead of both arms.
 *
 * Enumerated rather than "anything unparseable", because `"banana"`,
 * `"1.2"` and a truncated string are also unparseable and are evidence of
 * corruption, not of a dev build. Those still refuse. This mirrors
 * `evaluateHostClientFloor`, which exempts `LOCAL_CLI_VERSION` **by name**
 * with its own `unreleased-cli` verdict for exactly this reason — "so the
 * exemption cannot widen". Same constant, same discipline, and the two now
 * import one definition of the string.
 */
function actorVerdict(
  actor: "cli" | "desktop",
  version: string,
  floor: string,
  waived: NonReleaseAdmission[],
): CompatibilityFenceVerdict | null {
  const identity = nonReleaseIdentityKind(version);
  if (identity !== null) {
    waived.push({ actor, version, identity });
    return null;
  }
  const comparison = compareHostVersions(version, floor);
  if (!comparison.comparable) {
    return {
      kind: "refuse",
      reason:
        actor === "cli"
          ? "cli-version-incomparable"
          : "desktop-version-incomparable",
    };
  }
  if (comparison.ordering === "less") {
    return {
      kind: "refuse",
      reason: actor === "cli" ? "cli-below-floor" : "desktop-below-floor",
    };
  }
  return null;
}

// ---- Q1: verifying a host too old to carry the #1763 start stamp -----------

/**
 * How the verify leg is allowed to prove a host is the one it just installed.
 *
 * `identity-required` is the shipped rule and the strong one: `pid.json` must
 * carry `processStartIdentity` and that stamp must still name the live
 * process. `version-only` drops THAT comparison and nothing else - endpoint
 * validity, `host.status` readiness, the version agreement, the host-home
 * binding and the before/after re-read all remain.
 */
export type HostStampPolicy = "identity-required" | "version-only";

/**
 * May the verify leg fall back to version-only health for this TARGET?
 *
 * ## The bug this exists to close (Q1)
 *
 * No released host through 1.3.0-rc.3 writes `processStartIdentity`, so
 * `readRunningObservation` answers `unreadable("pid-start-stamp-missing")` for
 * every one of them, the verify leg polls a condition that can never become
 * true, and after the whole 45s budget a CORRECT install of a HEALTHY host is
 * recorded `failed` and exits `E_HOST_UPDATE_HEALTH_CHECK_FAILED`. It is
 * reached by `--allow-downgrade` rollbacks and by Desktop rollback - the paths
 * people take when an update has already gone wrong, so the failure lands at
 * the worst possible moment. It is not reached by ordinary forward updates,
 * which is why it survived to the matrix.
 *
 * ## Why the gate is on the TARGET, not on the observation
 *
 * "The stamp is missing" is a fact about the host we are looking at, which is
 * exactly what an accident or an attacker influences; "the target is below the
 * floor" is a fact about the version this run was asked to install, decided
 * before any of it ran. Gating on the target makes it STRUCTURALLY impossible
 * for a post-floor target to take the weak arm - a stamp-less post-floor host
 * still fails, loudly, as it does today. That is the constraint, and gating
 * this way enforces it rather than relying on care.
 *
 * ## Why a degrade and never a refusal
 *
 * A pre-download refusal would block rollback, and answering a question about
 * the target's AGE with a user override (`--force`) would overload a flag that
 * already means something else here. This is the mirror of the fence's own
 * hard constraint this round - it must not refuse the upgrade path - applied
 * to the target side.
 *
 * ## The three fail-safe directions, all pointing the same way
 *
 * Every uncertainty resolves to `identity-required`, which is today's shipped
 * behaviour, so no input can make this function a regression:
 *
 *  - an UNPINNED floor keeps the strong rule. Note this is the OPPOSITE of
 *    {@link decideCompatibilityFence}, which refuses everything on the
 *    sentinel, and both are fail-closed in their own direction: refusing to
 *    ADMIT is safe, while refusing to VERIFY is precisely the Q1 bug. An
 *    unpinned floor must not silently switch verification to the weak arm
 *    either, so it holds the strong one;
 *  - an INCOMPARABLE target keeps the strong rule. "Cannot tell how old it is"
 *    is not evidence that it is old;
 *  - anything at or above the floor keeps the strong rule.
 *
 * Known and accepted consequence: a `0.0.0-local` target compares BELOW any
 * pinned floor and therefore degrades, even though a host built from current
 * source does write the stamp. Deliberately not exempted by name - the cost is
 * a weaker check on a dev build that is RECORDED as weaker, whereas exempting
 * it would fail a dev host that genuinely predates the stamp, which is the
 * failure this whole function exists to remove.
 *
 * Takes the floor as a parameter rather than reading module scope, for the
 * same reason {@link decideCompatibilityFence} takes `floors`: a gate that can
 * only be exercised in its shipped configuration can only ever prove its
 * shipped configuration, and the interesting behaviour is what happens once
 * the floor IS pinned.
 */
export function decideHostStampPolicy(
  targetVersion: string,
  floor: string,
): HostStampPolicy {
  if (floor === COMPATIBILITY_FLOOR_UNPINNED) return "identity-required";
  const target = compareHostVersions(targetVersion, floor);
  if (!target.comparable) return "identity-required";
  return target.ordering === "less" ? "version-only" : "identity-required";
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
 *
 * ## WIRED, mirror-owned, and the reason it could not live at the claim
 *
 * `legacyMarkerPresent` is not "a marker exists". The executor MIRRORS its own
 * writes onto that marker, and its entry mirror deliberately TAKES OVER any
 * record it finds — so at claim time a foreign marker is ambiguous between a
 * stale file (common, benign, and what the takeover exists to absorb) and a
 * live lock-blind updater. A check there aborts good updates on stale markers,
 * which is why the first attempt at `runArm`'s entry was withdrawn.
 *
 * This function's own contract already said the right thing — a marker
 * "appearing WHILE a schema-v2 attempt is live" — and appearing is the word
 * that carries the weight: the evidence is a TRANSITION, and only the mirror
 * can see one, because only it knows whether its own write landed.
 *
 * The caller is therefore `MarkerMirror.foreignTakeoverObserved`, latched from
 * inside the segment, and it arms on exactly two facts:
 *
 *  - a read finds a marker that is not ours AFTER ours landed;
 *  - the entry takeover EXHAUSTED its retries, meaning three consecutive
 *    lock-held writes lost a race to someone else's. Under the lock the only
 *    other writer of this file is another CLI, so that is a concurrent
 *    updater caught in the act.
 *
 * It never arms on a write that failed on I/O: that is evidence of our own
 * write not landing and of nothing else, and the legacy marker is best-effort
 * by contract — a marker read that throws must never fail an update. Those two
 * null-`own` exits look identical at the call site and mean opposite things;
 * conflating them (cold review C) disarmed the detector on precisely the run
 * most likely to have something to detect.
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
 *
 * ## DELIBERATELY UNWIRED, unlike the preventive half beside it
 *
 * Not an oversight and not the same omission the floors were. This function
 * resolves a SIGNED REMOTE policy, and nothing in this repository produces a
 * `SignedCohortPolicy`: there is no fetch, no signature verification, no
 * freshness clock, and no key. Wiring it today could only ever pass `null`,
 * which by its own contract degrades to the static default — so the call would
 * add a branch that provably cannot change an outcome, while reading as though
 * a kill switch were live.
 *
 * That reads worse than absence. An operator who finds `resolveCohortPolicy`
 * called at admission will reasonably believe a remote disable exists and can
 * be reached in an incident; discovering mid-incident that the channel was
 * never built is the expensive way to learn it. The switch becomes real when
 * its transport does — the four O4 conditions, signature verified BEFORE the
 * policy is consulted — and it is one call site away when that lands.
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
