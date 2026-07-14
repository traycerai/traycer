import { access, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import type { Environment } from "../runner/environment";
import { createCliLogger, type ILogger } from "../logger";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { readHostStagedRecordAt } from "../manifest/host-staged";
import { hostInstallDir, hostStagedDir } from "../store/paths";
import { sweepOwnedTempDirs } from "../store/owned-temp";
import {
  currentInstallArch,
  currentInstallPlatform,
  renameWithRetry,
  sweepOldTrash,
} from "./install";

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

// `<target>.<infix>*` siblings, newest first. The suffix is a
// `Date.now()` millisecond timestamp (see `atomicSwap`/aside-replace call
// sites) - lexicographic sort on same-length numeric strings is a numeric
// sort, and will remain so until the year 2286 (13-digit epoch ms).
async function listAsideDirsNewestFirst(
  target: string,
  infix: string,
): Promise<string[]> {
  const parent = dirname(target);
  const prefix = `${basename(target)}.${infix}`;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
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
): Promise<boolean> {
  const installDir = hostInstallDir(environment);
  if (await pathExists(installDir)) return false;
  const candidates = await listOldAsideDirsNewestFirst(installDir);
  for (const candidate of candidates) {
    if (!(await validateInstallAsideCandidate(candidate, installDir))) continue;
    await renameWithRetry(candidate, installDir);
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
): Promise<boolean> {
  const installDir = hostInstallDir(environment);
  if (!(await pathExists(installDir))) return false;
  await sweepOldTrash(installDir);
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
      await renameWithRetry(candidate, stagedDir);
      logger.info("Stage reconcile restored staged/ from an aside copy", {
        environment,
        candidate,
      });
      return "restored";
    }
  }
  await Promise.all(
    candidates.map((candidate) =>
      invalidateStagedAsideDir(stagedDir, candidate, logger),
    ),
  );
  await sweepDeadStagedAsideDirs(stagedDir);
  return "deleted";
}

// Invalidates an aside that is being discarded outright (pure litter) -
// never for the crash-recovery restore path above, which needs the
// sidecar intact to validate a candidate. Shared between here (step 4's
// pure-litter branch) and `download-stage.ts`'s `replaceStagedDir`, which
// creates asides via the same explicit-replace path this cleans up after.
//
// Layered so a partial failure at any one layer can never leave a fully
// intact, step-4-restorable aside behind (the vulnerability a single
// "unlink sidecar, then best-effort rm" pass still had: if BOTH steps
// failed - e.g. a Windows open-file handle blocking both - the aside
// stayed completely valid and could resurrect an explicitly-replaced
// stage on a later reconcile pass):
//   1. Rename to a `.dead-*` sibling - a structurally different name
//      `listOldAsideDirsNewestFirst` never matches, so step 4 can never
//      again consider it a restore candidate regardless of what happens
//      to its contents afterward. `sweepDeadStagedAsideDirs` deletes
//      `.dead-*` siblings best-effort on a later pass. Tried first (and
//      via `renameWithRetry`) because a directory rename has the best
//      chance of succeeding even when a file inside is open.
//   2. If the rename fails, unlink just the sidecar - without
//      `staged.json`, `readHostStagedRecordAt` returns null and step 3/4
//      both treat the directory as invalid, so it's unrecoverable even
//      though it lingers (and will still be listed as `.old-*` litter,
//      swept by a subsequent reconcile pass's own retry of this same
//      function).
//   3. If that also fails, attempt a full recursive removal.
//   4. If every layer fails, log and accept the residual - the aside
//      remains a fully valid, in principle restorable candidate. Narrow:
//      it requires rename, unlink, AND rm to all independently fail on
//      the same directory.
export async function invalidateStagedAsideDir(
  target: string,
  aside: string,
  logger: ILogger,
): Promise<void> {
  const deadAside = `${target}.dead-${Date.now()}`;
  try {
    await renameWithRetry(aside, deadAside);
    return;
  } catch {
    // Fall through to layer 2.
  }
  try {
    await unlink(join(aside, "staged.json"));
    return;
  } catch {
    // Fall through to layer 3.
  }
  try {
    await rm(aside, { recursive: true, force: true });
  } catch {
    logger.warn(
      "Stage reconcile could not invalidate a replaced stage aside on any layer - it remains restorable",
      { aside },
    );
  }
}

function listDeadStagedAsideDirsNewestFirst(target: string): Promise<string[]> {
  return listAsideDirsNewestFirst(target, "dead-");
}

// Best-effort cleanup of `.dead-*` siblings `invalidateStagedAsideDir`
// leaves behind on its (common) layer-1 success path - deliberately not
// deleted synchronously there, since the whole point of layer 1 is to
// succeed via a cheap rename even when the directory's contents can't yet
// be removed (e.g. a Windows file handle still closing).
async function sweepDeadStagedAsideDirs(target: string): Promise<void> {
  const dead = await listDeadStagedAsideDirsNewestFirst(target);
  await Promise.all(
    dead.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

export async function reconcileHostStage(
  environment: Environment,
): Promise<StageReconcileResult> {
  const logger = createCliLogger(environment);
  const targetMissingRecovered = await recoverMissingInstallTarget(
    environment,
    logger,
  );
  const installTrashSwept = await sweepInstallTrashIfTargetExists(environment);
  const installRecord = await readHostInstallRecord(environment);
  let stageDeletedReason = await evaluateStageForDeletion(
    environment,
    installRecord,
  );
  if (stageDeletedReason !== null) {
    await rm(hostStagedDir(environment), { recursive: true, force: true });
    logger.info("Stage reconcile deleted the staged tree", {
      environment,
      reason: stageDeletedReason,
    });
  }
  const stagedAsideOutcome = await reconcileStagedAside(environment, logger);
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
      await rm(hostStagedDir(environment), { recursive: true, force: true });
      logger.info(
        "Stage reconcile deleted a just-restored staged aside that failed re-evaluation",
        { environment, reason: restoredDeletionReason },
      );
      stageDeletedReason = restoredDeletionReason;
    }
  }
  const tempsSwept = await sweepOwnedTempDirs(environment);
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
