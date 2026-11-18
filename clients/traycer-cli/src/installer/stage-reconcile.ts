import { access, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import { encodeStageFingerprint } from "@traycer-clients/shared/host-version/stage-fingerprint";
import type { HostInstallRecord } from "@traycer/protocol/config/installation";
import type { Environment } from "../runner/environment";
import { createCliLogger, type ILogger } from "../logger";
import { readHostInstallRecord } from "../manifest/host-install";
import {
  readHostStagedRecord,
  readHostStagedRecordAt,
} from "../manifest/host-staged";
import { hostInstallDir, hostStagedDir } from "../store/paths";
import { sweepOwnedTempDirsWithVerifier } from "../store/owned-temp";
import {
  invalidateAsideDir,
  legacyMutationVerifier,
  listAsideDirsNewestFirst,
  sweepDeadAsideDirs,
} from "./aside-dirs";
import {
  currentInstallArch,
  currentInstallPlatform,
  sweepOldTrash,
} from "./install";
import { renameWithRetry } from "./rename-retry";

// CLI-owned stage reconciliation - Host Update Layer Redesign Tech Plan,
// "Stage lifecycle - CLI-owned reconciliation". Every locked mutating
// command is meant to run this, in order, under the `cli-lock`; ticket 1
// wires it into `host download`'s promote step only - ticket 2 wires it
// into apply/install/ensure/uninstall.
//
// Steps, in order (each one's ordering rationale lives inline below):
//   1. target-missing recovery (`install/` absent + `install.old-*`
//      present -> restore the newest valid aside) BEFORE any orphan rule,
//      so a stage isn't wrongly orphaned by a transient missing target.
//   2. install-trash sweep (target exists -> best-effort delete obsolete
//      `install.old-*` litter).
//   3. stage deletion rules (malformed/unknown-schema sidecar,
//      platform-arch mismatch, missing executable, comparable
//      staged <= installed, orphan/no install record).
//   4. `staged.old-*` aside recovery (delete when `staged/` exists, else
//      restore the newest valid aside).
//   5. owner-tokened temp sweep (identity outranks age).

export type StageDeletionReason =
  // The sidecar reader is deliberately tolerant (returns `null` for BOTH
  // malformed JSON and an unknown `schemaVersion`, per the Tech Plan) -
  // reconcile can't distinguish the two after the fact without forking
  // that contract, so both collapse to one reason here.
  | "invalid-sidecar"
  | "platform-arch-mismatch"
  | "executable-missing"
  | "stale-or-equal-version"
  | "orphan-no-install-record";

export type StagedAsideOutcome = "deleted" | "restored" | "none";

export interface StageReconcileResult {
  readonly targetMissingRecovered: boolean;
  readonly installTrashSwept: boolean;
  readonly stageDeletedReason: StageDeletionReason | null;
  readonly stagedAsideOutcome: StagedAsideOutcome;
  readonly tempsSwept: readonly string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Re-verified at USE time (not just at sidecar-parse time) - this stays
// meaningful even though `readHostStagedRecordAt` already structurally
// validates `executablePath`, because disk state can change in the gap
// between reading the sidecar and reconcile deciding what to do with it
// (e.g. the executable removed out from under a stage). `stat().isFile()`
// rather than a bare existence check so a directory left at that path
// (e.g. a partial extraction) is correctly treated as missing.
async function stagedExecutableIsFile(
  stagedDirLikePath: string,
  executablePath: string,
): Promise<boolean> {
  try {
    const st = await stat(join(stagedDirLikePath, executablePath));
    return st.isFile();
  } catch {
    return false;
  }
}

function listOldAsideDirsNewestFirst(target: string): Promise<string[]> {
  return listAsideDirsNewestFirst(target, "old-");
}

// "Valid" here means good enough to safely restore in place of a missing
// `install/`: a parseable `install.json` whose platform/arch match this
// machine and whose recorded executable actually exists under the
// candidate dir. This is a lighter check than `readHostInstallRecord`'s
// full strict schema validation (which reads a fixed canonical path, not
// an arbitrary aside candidate, and throws rather than returning null) -
// proportionate to the failure mode being healed: an aside dir was a
// complete, working install moments before the crash that left it there.
async function validateInstallAsideCandidate(
  candidateDir: string,
  installDir: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(candidateDir, "install.json"), "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "string") return false;
  if (obj.platform !== currentInstallPlatform()) return false;
  if (obj.arch !== currentInstallArch()) return false;
  if (typeof obj.executablePath !== "string") return false;
  const relPath = relative(installDir, obj.executablePath);
  if (relPath.startsWith("..") || isAbsolute(relPath)) return false;
  return pathExists(join(candidateDir, relPath));
}

// Step 1.
async function recoverMissingInstallTarget(
  environment: Environment,
  logger: ILogger,
  verifyMutationCapability: () => Promise<void>,
): Promise<boolean> {
  const installDir = hostInstallDir(environment);
  if (await pathExists(installDir)) return false;
  const candidates = await listOldAsideDirsNewestFirst(installDir);
  for (const candidate of candidates) {
    if (!(await validateInstallAsideCandidate(candidate, installDir))) continue;
    await renameWithRetry(candidate, installDir, verifyMutationCapability);
    logger.info("Stage reconcile restored install/ from an aside copy", {
      environment,
      candidate,
    });
    return true;
  }
  return false;
}

// Step 2.
async function sweepInstallTrashIfTargetExists(
  environment: Environment,
  logger: ILogger,
  verifyMutationCapability: () => Promise<void>,
): Promise<boolean> {
  const installDir = hostInstallDir(environment);
  if (!(await pathExists(installDir))) return false;
  await sweepOldTrash(
    installDir,
    "install.json",
    logger,
    verifyMutationCapability,
  );
  return true;
}

// Step 3. `installRecord` must be read AFTER step 1 so an install/
// restored moments ago is what "no install record -> orphan" is judged
// against, not stale pre-reconcile state.
async function evaluateStageForDeletion(
  environment: Environment,
  installRecord: HostInstallRecord | null,
): Promise<StageDeletionReason | null> {
  const stagedDir = hostStagedDir(environment);
  if (!(await pathExists(stagedDir))) return null;
  const record = await readHostStagedRecordAt(stagedDir);
  if (record === null) return "invalid-sidecar";
  if (
    record.platform !== currentInstallPlatform() ||
    record.arch !== currentInstallArch()
  ) {
    return "platform-arch-mismatch";
  }
  if (!(await stagedExecutableIsFile(stagedDir, record.executablePath))) {
    return "executable-missing";
  }
  // Version comparison is only meaningful once we know there IS an
  // install record to compare against - orphan is checked before it,
  // not after, despite the Tech Plan's prose listing it last.
  if (installRecord === null) return "orphan-no-install-record";
  const cmp = compareHostVersions(record.version, installRecord.version);
  if (cmp.comparable && cmp.ordering !== "greater") {
    return "stale-or-equal-version";
  }
  return null;
}

// Step 4. Mirrors step 1's aside-recovery shape but for `staged/`: when
// `staged/` already exists the asides are pure litter (redundant, always
// deleted); when it's missing, restore the newest valid one so a crash
// between "rename staged aside" and "rename new stage in" (the explicit-
// version replace dance in `host download`'s promote) self-heals. If no
// aside is valid, they're swept rather than left to linger forever.
async function reconcileStagedAside(
  environment: Environment,
  logger: ILogger,
  verifyMutationCapability: () => Promise<void>,
): Promise<StagedAsideOutcome> {
  const stagedDir = hostStagedDir(environment);
  const candidates = await listOldAsideDirsNewestFirst(stagedDir);
  if (candidates.length === 0) return "none";
  const stagedExists = await pathExists(stagedDir);
  if (!stagedExists) {
    for (const candidate of candidates) {
      const record = await readHostStagedRecordAt(candidate);
      if (record === null) continue;
      if (
        record.platform !== currentInstallPlatform() ||
        record.arch !== currentInstallArch()
      ) {
        continue;
      }
      if (!(await stagedExecutableIsFile(candidate, record.executablePath))) {
        continue;
      }
      await renameWithRetry(candidate, stagedDir, verifyMutationCapability);
      logger.info("Stage reconcile restored staged/ from an aside copy", {
        environment,
        candidate,
      });
      return "restored";
    }
  }
  for (const candidate of candidates) {
    await verifyMutationCapability();
    await invalidateAsideDir(
      stagedDir,
      candidate,
      "staged.json",
      logger,
      verifyMutationCapability,
    );
  }
  return "deleted";
}

// Explicit curation invalidation is deliberately NOT expressed as a normal
// reconcile: reconcile restores a valid `staged.old-*` when canonical
// `staged/` is absent. A yanked stage must instead make both canonical and
// every recoverable aside permanently ineligible before the next reconcile
// can run. Caller owns cli-lock. A command-driven purge supplies the exact
// stage fingerprint it judged withdrawn: a different stage arriving while a
// registry probe was in flight is a stale verdict, never authority to delete
// the replacement. Internal locked callers that just read their own manifest
// pass null and retain their existing unconditional invalidation behavior.
export type PurgeHostStageResult =
  | { readonly outcome: "purged"; readonly purged: true }
  | {
      readonly outcome: "stage-fingerprint-mismatch";
      readonly purged: false;
      readonly actualStageFingerprint: string | null;
    };

export async function purgeHostStage(
  environment: Environment,
  expectedStageFingerprint: string | null,
  verifyMutationCapability: () => Promise<void>,
): Promise<PurgeHostStageResult> {
  // Every destructive edge below receives an explicit verifier. Legacy
  // maintenance passes `legacyMutationVerifier` deliberately; production
  // contender paths pass their live capability verifier.
  const verify = verifyMutationCapability;
  const logger = createCliLogger(environment);
  const stagedDir = hostStagedDir(environment);
  const staged = await readHostStagedRecord(environment);
  const actualStageFingerprint =
    staged?.stageId === null || staged?.stageId === undefined
      ? null
      : encodeStageFingerprint(staged.stageId);
  if (
    expectedStageFingerprint !== null &&
    actualStageFingerprint !== expectedStageFingerprint
  ) {
    return {
      outcome: "stage-fingerprint-mismatch",
      purged: false,
      actualStageFingerprint,
    };
  }
  await verify();
  await rm(stagedDir, { recursive: true, force: true });
  const asides = await listAsideDirsNewestFirst(stagedDir, "old-");
  const invalidated: boolean[] = [];
  for (const aside of asides) {
    await verify();
    invalidated.push(
      await invalidateAsideDir(stagedDir, aside, "staged.json", logger, verify),
    );
  }
  if (invalidated.some((outcome) => !outcome)) {
    throw new Error(
      "Could not invalidate every recoverable staged aside; the stage was not purged.",
    );
  }
  await verify();
  await sweepDeadAsideDirs(stagedDir, verify);
  logger.info("Host stage purged", {
    environment,
    recoverableAsideCount: asides.length,
  });
  return { outcome: "purged", purged: true };
}

async function reconcileHostStageWithVerifier(
  environment: Environment,
  verifyMutationCapability: () => Promise<void>,
): Promise<StageReconcileResult> {
  const logger = createCliLogger(environment);
  const targetMissingRecovered = await recoverMissingInstallTarget(
    environment,
    logger,
    verifyMutationCapability,
  );
  const installTrashSwept = await sweepInstallTrashIfTargetExists(
    environment,
    logger,
    verifyMutationCapability,
  );
  const installRecord = await readHostInstallRecord(environment);
  let stageDeletedReason = await evaluateStageForDeletion(
    environment,
    installRecord,
  );
  if (stageDeletedReason !== null) {
    await verifyMutationCapability();
    await rm(hostStagedDir(environment), { recursive: true, force: true });
    logger.info("Stage reconcile deleted the staged tree", {
      environment,
      reason: stageDeletedReason,
    });
  }
  const stagedAsideOutcome = await reconcileStagedAside(
    environment,
    logger,
    verifyMutationCapability,
  );
  // Unconditional and independent of `stagedAsideOutcome` above -
  // `.dead-*` siblings are litter `invalidateAsideDir`'s layer-1
  // rename leaves behind regardless of whether THIS pass found any
  // `.old-*` candidates to invalidate (the common case after a completed
  // replacement has none) or restored one instead. A call site nested
  // inside `reconcileStagedAside`'s pure-litter branch was unreachable on
  // both of those paths, so `.dead-*` trees accumulated forever.
  await sweepDeadAsideDirs(
    hostStagedDir(environment),
    verifyMutationCapability,
  );
  if (stagedAsideOutcome === "restored") {
    // Step 4's own validation (parseable sidecar + platform/arch match +
    // executable present) is a lighter "good enough to try" check than
    // step 3's full eligibility rules (it doesn't compare against the
    // install record at all) - a restored aside can still be stale,
    // orphaned, or otherwise fail step 3. Re-run step 3 against what is
    // now at `staged/` so one reconcile pass never ends with a stage
    // that violates its own rules; the next pass would just delete it
    // anyway, but leaving it in place until then is observable state
    // ticket 2's apply/install/ensure flows shouldn't have to tolerate.
    const restoredDeletionReason = await evaluateStageForDeletion(
      environment,
      installRecord,
    );
    if (restoredDeletionReason !== null) {
      await verifyMutationCapability();
      await rm(hostStagedDir(environment), { recursive: true, force: true });
      logger.info(
        "Stage reconcile deleted a just-restored staged aside that failed re-evaluation",
        { environment, reason: restoredDeletionReason },
      );
      stageDeletedReason = restoredDeletionReason;
    }
  }
  const tempsSwept = await sweepOwnedTempDirsWithVerifier(
    environment,
    verifyMutationCapability,
  );
  logger.debug("Stage reconcile completed", {
    environment,
    targetMissingRecovered,
    installTrashSwept,
    stageDeletedReason,
    stagedAsideOutcome,
    tempsSweptCount: tempsSwept.length,
  });
  return {
    targetMissingRecovered,
    installTrashSwept,
    stageDeletedReason,
    stagedAsideOutcome,
    tempsSwept,
  };
}

// Legacy maintenance callers retain their established no-capability behavior.
// All attempt-bound install/download/apply paths use the explicit verifier
// variant below so every rename/remove inside reconciliation rechecks the
// same live capability immediately before the edge.
export async function reconcileHostStage(
  environment: Environment,
): Promise<StageReconcileResult> {
  return reconcileHostStageWithVerifier(environment, legacyMutationVerifier);
}

export async function reconcileHostStageWithAttempt(
  environment: Environment,
  verifyMutationCapability: () => Promise<void>,
): Promise<StageReconcileResult> {
  return reconcileHostStageWithVerifier(environment, verifyMutationCapability);
}
