import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  copyFile,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  readCliManifest,
  type CliInstallManifest,
  type CliInstallSource,
} from "../manifest/cli-manifest";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, isErrnoException } from "../runner/errors";
import { renameWithRetryLegacy } from "../installer/rename-retry";
import { resolveCliVersion } from "../cli-version";
import { isStrictlyNewerHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import { errorFromUnknown } from "../logger";
import { withCliLock } from "./cli-lock";
import {
  cliInstallHomeDir,
  ensureCliInstallHomeDir,
  ensurePrivateDir,
} from "./paths";

// Host `resolveCliExecutablePath` shells the CLI exclusively at `<cliInstallHomeDir>/bin/traycer[.exe]`.
export function wellKnownCliBinaryPath(environment: Environment): string {
  const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
  return join(cliInstallHomeDir(environment), "bin", binaryName);
}

// npm ships an interpreter script; never copy it into the well-known slot.
export function isInterpreterDistribution(source: CliInstallSource): boolean {
  return source === "npm";
}

// Lives here so slot-refresh can gate on packaged-ness without importing a module tests mock wholesale.
export async function isPackagedRun(): Promise<boolean> {
  try {
    const { isSea } = await import("node:sea");
    return isSea();
  } catch {
    return false;
  }
}

// Packaged-only refresh with waitMs 0. Manifest binary is the source of truth, not the running process; only the locked second look may copy.
export async function refreshWellKnownSlotIfStale(
  environment: Environment,
): Promise<WellKnownCliStageOutcome | null> {
  return refreshSlot(environment, 0);
}

// How long the supervised entry waits for the lock. See
// `refreshWellKnownSlotForSupervisedStart` for why this one waits at all.
const SUPERVISED_START_LOCK_WAIT_MS = 5_000;

// Supervised `host start` waits for the lock: a skipped refresh would keep the previous CLI image until the next service restart.
export async function refreshWellKnownSlotForSupervisedStart(
  environment: Environment,
): Promise<WellKnownCliStageOutcome | null> {
  return refreshSlot(environment, SUPERVISED_START_LOCK_WAIT_MS);
}

// One implementation behind both wrappers so they cannot drift on what stale means.
async function refreshSlot(
  environment: Environment,
  lockWaitMs: number,
): Promise<WellKnownCliStageOutcome | null> {
  if (!(await isPackagedRun())) return null;
  const wellKnownPath = wellKnownCliBinaryPath(environment);
  const running = resolve(process.execPath);
  // Cheap unlocked pre-check, so the common "nothing changed" path never
  // touches the lock file at all.
  const planned = await slotRefreshPlan(environment, wellKnownPath, running);
  if (planned.kind === "current") return null;
  try {
    return await withCliLock(
      {
        environment,
        reason: "refresh-well-known-slot",
        // An adoption is never worth waiting for, whatever the caller's lockWaitMs.
        waitMs: planned.kind === "adopt" ? 0 : lockWaitMs,
        pollIntervalMs: 100,
      },
      async () => {
        const plan = await slotRefreshPlan(environment, wellKnownPath, running);
        if (plan.kind === "current") return null;
        if (plan.kind === "adopt") {
          // Under the lock, so nothing can have replaced the slot since the lstat that proved the mirror.
          await writeSlotSourceRecord(
            wellKnownPath,
            plan.source,
            plan.sourceStat,
          );
          return null;
        }
        // Absent, dangling, or holding something else is not a mirror; do not adopt a record for it.
        return stageWellKnownCliBinary({
          environment,
          binaryPath: plan.source,
        });
      },
    );
  } catch (error) {
    // Catch only `CLI_LOCK_BUSY`. A filesystem fault while taking the lock is not contention.
    if (isCliLockBusyError(error)) {
      // Losing the lock on an adoption defers nothing the caller needs; return null.
      const current = await slotRefreshPlan(
        environment,
        wellKnownPath,
        running,
      );
      if (current.kind !== "stage") return null;
      return { staged: "deferred-busy", wellKnownPath };
    }
    const failure = errorFromUnknown(error);
    return {
      staged: "failed",
      wellKnownPath,
      errorName: failure.name,
      errorMessage: failure.message,
    };
  }
}

// One path in a form two spellings of the same file both reduce to. Used to detect the slot-is-source case.
export async function canonicalBinaryPath(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => resolve(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

// Whether this process's image came from the well-known slot (symlink-aware).
export async function isRunningFromWellKnownSlot(
  environment: Environment,
): Promise<boolean> {
  return (
    (await canonicalBinaryPath(process.execPath)) ===
    (await canonicalBinaryPath(wellKnownCliBinaryPath(environment)))
  );
}

// Whether this is the lock module's own "another writer holds it" signal, as
// opposed to a filesystem fault raised while trying to take the lock.
function isCliLockBusyError(error: unknown): boolean {
  return (
    error instanceof CliError && error.code === CLI_ERROR_CODES.CLI_LOCK_BUSY
  );
}

// Unlocked pre-check so the common nothing-changed path never touches the lock.
export async function wellKnownSlotRefreshHasConverged(
  environment: Environment,
): Promise<boolean> {
  const plan = await slotRefreshPlan(
    environment,
    wellKnownCliBinaryPath(environment),
    resolve(process.execPath),
  );
  return plan.kind !== "stage";
}

// What a refresh has to do about the slot: stage, adopt a record, or leave it.
type SlotRefreshPlan =
  // Leave the slot alone - it holds the right bytes, or nothing can be said
  // about what the right bytes would be.
  | { readonly kind: "current" }
  // Copy the slot from `source`.
  | { readonly kind: "stage"; readonly source: string }
  // The slot already mirrors `source`, but carries no record that proves it.
  // Write one from `sourceStat`, the very stat that proved the mirror.
  | {
      readonly kind: "adopt";
      readonly source: string;
      readonly sourceStat: Stats;
    };

// What to do about the slot: stage it, adopt a record for it, or leave it.
async function slotRefreshPlan(
  environment: Environment,
  wellKnownPath: string,
  running: string,
): Promise<SlotRefreshPlan> {
  const nominated = await authoritativeSlotSource(environment, running);
  if (nominated === null) return { kind: "current" };
  const { path: source, anchored } = nominated;
  if (resolve(wellKnownPath) === source) return { kind: "current" };
  // An unanchored nomination may fill or refresh a slot, never demote one.
  const guardedStage = async (): Promise<SlotRefreshPlan> => {
    if (!anchored && (await slotOutranksRunning(wellKnownPath))) {
      return { kind: "current" };
    }
    return { kind: "stage", source };
  };
  // `lstat`, not `stat`: the slot must be inspected as the directory entry it is.
  const slotStat = await lstatOrNull(wellKnownPath);
  if (slotStat === null) return { kind: "stage", source };
  if (slotStat.isSymbolicLink()) {
    // An unanchored nomination may fill or refresh a slot, never demote one. Probe the link target; a newer target is left alone.
    if (!anchored) {
      const target = await realpath(wellKnownPath).catch(() => null);
      if (target !== null && (await slotOutranksRunning(target))) {
        return { kind: "current" };
      }
    }
    return { kind: "stage", source };
  }
  // Staging record is the authority whenever it applies; freshness must not depend on reproducing a timestamp.
  const record = await readSlotSourceRecord(wellKnownPath);
  if (record !== null && recordDescribes(record, slotStat, source)) {
    const sourceStat = await statOrNull(source);
    if (sourceStat === null) return { kind: "current" };
    return sourceIsUnchanged(record, sourceStat)
      ? { kind: "current" }
      : guardedStage();
  }
  // No usable record: fall back to size/mtime mirror, and adopt a record once if the slot already matches.
  const mirroredSource = await mirroredSourceStat(slotStat, source);
  if (mirroredSource === null) return guardedStage();
  return { kind: "adopt", source, sourceStat: mirroredSource };
}

// `true` is the only answer that suppresses an unanchored stage. Spawn the candidate; do not probe this process's own image.
async function slotOutranksRunning(candidatePath: string): Promise<boolean> {
  if (
    (await canonicalBinaryPath(candidatePath)) ===
    (await canonicalBinaryPath(process.execPath))
  ) {
    return false;
  }
  // Answering `--version` proves a program runs, not that it may hold the slot. Interpreter distributions must not occupy it.
  if (!(await isSlotEligibleBinary(candidatePath))) return false;
  let reported: string;
  try {
    const { stdout } = await execFileAsync(candidatePath, ["--version"], {
      timeout: SLOT_VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    reported = stdout.trim();
  } catch {
    return false;
  }
  return isStrictlyNewerHostVersion(reported, resolveCliVersion(process.env));
}

const SLOT_VERSION_PROBE_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

// Occupying the slot is not the same as answering `--version`; interpreter distributions are refused.
async function isSlotEligibleBinary(binaryPath: string): Promise<boolean> {
  if (
    process.platform === "win32" &&
    !binaryPath.toLowerCase().endsWith(".exe")
  ) {
    return false;
  }
  // Regular file first: opening a FIFO would block. O_NOFOLLOW so a swapped-in symlink is not followed.
  const candidateStat = await statOrNull(binaryPath);
  if (candidateStat === null || !candidateStat.isFile()) return false;
  let handle: FileHandle;
  try {
    // O_NONBLOCK closes the window in which the candidate could become a FIFO. Absent on Windows.
    handle = await open(
      binaryPath,
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK,
    );
  } catch {
    return false;
  }
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return !(bytesRead === 2 && buffer[0] === 0x23 && buffer[1] === 0x21);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Nominated source plus whether an install authority vouches for it.
interface NominatedSlotSource {
  readonly path: string;
  readonly anchored: boolean;
}

// Manifest wins when it names an existing executable; npm owns no slot.
async function authoritativeSlotSource(
  environment: Environment,
  running: string,
): Promise<NominatedSlotSource | null> {
  let manifest: CliInstallManifest | null;
  try {
    manifest = await readCliManifest(environment);
  } catch {
    // Unreadable is not absent and must not fall back to the running binary.
    return null;
  }
  if (manifest === null) return { path: running, anchored: false };
  if (isInterpreterDistribution(manifest.source)) return null;
  const manifestBinary = resolve(manifest.binaryPath);
  // Only a confirmed absence may demote the manifest's binary.
  switch (await probePresence(manifestBinary)) {
    case "present":
      return { path: manifestBinary, anchored: true };
    case "absent":
      // Manifested binary is gone, so the self-nomination is as unanchored as the no-manifest case.
      return { path: running, anchored: false };
    case "unknown":
      return null;
  }
}

type PathPresence = "present" | "absent" | "unknown";

async function probePresence(path: string): Promise<PathPresence> {
  try {
    await stat(path);
    return "present";
  } catch (error) {
    return isEnoentError(error) ? "absent" : "unknown";
  }
}

// One errno narrow for this module, shared with `renameSlotBinaryAside`.
function isEnoentError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}

// Faithful copy of `source` by the staging record's ino/dev identity, not size/mtime.
async function mirroredSourceStat(
  slotStat: Stats,
  source: string,
): Promise<Stats | null> {
  const sourceStat = await statOrNull(source);
  if (sourceStat === null) return null;
  const mirrored =
    slotStat.size === sourceStat.size &&
    slotStat.mtime.getTime() === sourceStat.mtime.getTime();
  return mirrored ? sourceStat : null;
}

// Staging record is identity (ino/dev), not size/mtime: package managers rename onto a new inode and can preserve archive timestamps.
interface SlotSourceRecord {
  readonly sourcePath: string;
  readonly sourceSize: number;
  readonly sourceMtimeMs: number;
  readonly sourceIno: number;
  readonly sourceDev: number;
  readonly slotSize: number;
  readonly slotMtimeMs: number;
}

// Whether `sourceStat` is still the file the slot was staged from.
function sourceIsUnchanged(
  record: SlotSourceRecord,
  sourceStat: Stats,
): boolean {
  return (
    sourceStat.size === record.sourceSize &&
    sourceStat.mtimeMs === record.sourceMtimeMs &&
    sourceStat.ino === record.sourceIno &&
    sourceStat.dev === record.sourceDev
  );
}

function slotSourceRecordPath(wellKnownPath: string): string {
  return `${wellKnownPath}${SLOT_SOURCE_RECORD_SUFFIX}`;
}

// `mtimeMs` here: both observations of one real file, with no `utimes` round trip to truncate precision.
function recordDescribes(
  record: SlotSourceRecord,
  slotStat: Stats,
  source: string,
): boolean {
  return (
    record.sourcePath === source &&
    record.slotSize === slotStat.size &&
    record.slotMtimeMs === slotStat.mtimeMs
  );
}

async function readSlotSourceRecord(
  wellKnownPath: string,
): Promise<SlotSourceRecord | null> {
  let raw: string;
  try {
    raw = await readFile(slotSourceRecordPath(wellKnownPath), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  // Every field required: a record written by an older CLI is unusable, not partially trusted.
  if (
    typeof value.sourcePath !== "string" ||
    typeof value.sourceSize !== "number" ||
    typeof value.sourceMtimeMs !== "number" ||
    typeof value.sourceIno !== "number" ||
    typeof value.sourceDev !== "number" ||
    typeof value.slotSize !== "number" ||
    typeof value.slotMtimeMs !== "number"
  ) {
    return null;
  }
  return {
    sourcePath: value.sourcePath,
    sourceSize: value.sourceSize,
    sourceMtimeMs: value.sourceMtimeMs,
    sourceIno: value.sourceIno,
    sourceDev: value.sourceDev,
    slotSize: value.slotSize,
    slotMtimeMs: value.slotMtimeMs,
  };
}

// Write the staging record after publish: a record that never described live bytes must not suppress the next refresh.
async function writeSlotSourceRecord(
  wellKnownPath: string,
  source: string,
  sourceIdentity: Stats,
): Promise<void> {
  const slotStat = await statOrNull(wellKnownPath);
  if (slotStat === null) return;
  const record: SlotSourceRecord = {
    sourcePath: source,
    sourceSize: sourceIdentity.size,
    sourceMtimeMs: sourceIdentity.mtimeMs,
    sourceIno: sourceIdentity.ino,
    sourceDev: sourceIdentity.dev,
    slotSize: slotStat.size,
    slotMtimeMs: slotStat.mtimeMs,
  };
  await writeFile(
    slotSourceRecordPath(wellKnownPath),
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8", mode: 0o600 },
  ).catch(() => undefined);
}

// Whether two stats of the same path describe the same unreplaced file (ino/dev).
function isSameFile(before: Stats, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
  );
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

// Does not follow symlinks: inspect the directory entry, not the target.
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

export type WellKnownCliStageOutcome =
  // Slot already is this binary; skip so a Desktop-staged slot is not replaced with a copy of itself.
  | { readonly staged: "already-well-known"; readonly wellKnownPath: string }
  // The slot now holds a fresh COPY of the binary's bytes.
  | { readonly staged: "staged"; readonly wellKnownPath: string }
  // Interpreter distribution: leave the slot alone and report rather than silently drop.
  | { readonly staged: "not-applicable"; readonly wellKnownPath: string }
  // Refresh wanted but another writer held the CLI lock, so nothing was copied.
  | { readonly staged: "deferred-busy"; readonly wellKnownPath: string }
  // Best-effort failure: the caller's primary contract still holds; only the host's view through this slot stays degraded.
  | {
      readonly staged: "failed";
      readonly wellKnownPath: string;
      readonly errorName: string;
      readonly errorMessage: string;
    };

// Stage the slot with a copy of `binaryPath`. Copy, never symlink. Windows may rename the live slot aside first.
export async function stageWellKnownCliBinary(opts: {
  readonly environment: Environment;
  readonly binaryPath: string;
}): Promise<WellKnownCliStageOutcome> {
  const wellKnownPath = wellKnownCliBinaryPath(opts.environment);
  const source = resolve(opts.binaryPath);
  if (resolve(wellKnownPath) === source) {
    return { staged: "already-well-known", wellKnownPath };
  }
  const staging = `${wellKnownPath}.staging-${process.pid}-${randomUUID()}`;
  // Non-null once Windows moved a pre-existing slot binary aside; a publish failure must put it back.
  let asidePath: string | null = null;
  try {
    // Create the install home first so a concurrent `service install` cannot fail with EEXIST before the lock.
    await ensureCliInstallHomeDir(opts.environment);
    await ensurePrivateDir(dirname(wellKnownPath));
    // Stat the source on both sides of the copy; if it moved, do not write a record for the old identity.
    const sourceBefore = await statOrNull(source);
    await copyFile(source, staging);
    await sweepSlotLeftovers(wellKnownPath, staging);
    if (process.platform === "win32") {
      asidePath = await renameSlotBinaryAside(wellKnownPath);
    } else {
      await chmod(staging, 0o755);
    }
    // Mirror the source's timestamps onto the copy so same-size upgrades with older archive mtimes are still detectable.
    const sourceAfter = await statOrNull(source);
    // The one stat PROVEN to describe the bytes now sitting in `staging`, or
    // null when the source moved under the copy and no such stat exists.
    const copiedSource =
      sourceBefore !== null &&
      sourceAfter !== null &&
      isSameFile(sourceBefore, sourceAfter)
        ? sourceAfter
        : null;
    if (copiedSource !== null) {
      await utimes(staging, copiedSource.atime, copiedSource.mtime).catch(
        () => undefined,
      );
    }
    // `renameWithRetry`, not a bare rename: Windows releases a dead handle asynchronously.
    await renameWithRetryLegacy(staging, wellKnownPath);
    // No record when the copy raced a replacement; the next run restages.
    if (copiedSource !== null) {
      await writeSlotSourceRecord(wellKnownPath, source, copiedSource);
    }
    return { staged: "staged", wellKnownPath };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    // Copy rather than link so the slot survives deletion of the source install.
    if (asidePath !== null) {
      // Retried hardest: this rename is the one whose failure would leave the slot absent.
      await renameWithRetryLegacy(asidePath, wellKnownPath).catch(
        () => undefined,
      );
    }
    const named = error instanceof Error ? error : new Error(String(error));
    return {
      staged: "failed",
      wellKnownPath,
      errorName: named.name,
      errorMessage: named.message,
    };
  }
}

// Move a possibly-running slot binary aside so a new image can take the stable name on Windows.
async function renameSlotBinaryAside(
  wellKnownPath: string,
): Promise<string | null> {
  const asidePath = `${wellKnownPath}.old-${Date.now()}-${process.pid}`;
  try {
    // Retried for the same Windows transient-handle window as the publish rename. ENOENT is not retried.
    await renameWithRetryLegacy(wellKnownPath, asidePath);
    return asidePath;
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  }
}

// Age-gate leftover `.old-` / `.staging-` files from the NAME, not mtime. Never sweep this invocation's own staging file.
const STAGING_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const ASIDE_INFLIGHT_WINDOW_MS = 5 * 60 * 1000;
// Sits beside the slot, named after it. Not swept: the sweep matches the
// `.old-` / `.staging-` prefixes, and this is neither.
const SLOT_SOURCE_RECORD_SUFFIX = ".source.json";

// Age from the name stamp, not mtime. Null (legacy name) sweeps.
function leftoverStampedAt(entry: string, prefix: string): number | null {
  const suffix = entry.slice(prefix.length);
  const separator = suffix.indexOf("-");
  const stamp = separator === -1 ? suffix : suffix.slice(0, separator);
  if (stamp.length === 0 || !/^\d+$/.test(stamp)) return null;
  const parsed = Number(stamp);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function sweepSlotLeftovers(
  wellKnownPath: string,
  ownStagingPath: string,
): Promise<void> {
  const dir = dirname(wellKnownPath);
  const name = basename(wellKnownPath);
  const asidePrefix = `${name}.old-`;
  const stagingPrefix = `${name}.staging-`;
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const ownStagingName = basename(ownStagingPath);
  const now = Date.now();
  const stagingCutoff = now - STAGING_ORPHAN_MIN_AGE_MS;
  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry.startsWith(asidePrefix)) {
      const stampedAt = leftoverStampedAt(entry, asidePrefix);
      // A future stamp (clock stepped backwards) must not pin the file forever.
      const age = stampedAt === null ? null : now - stampedAt;
      if (age !== null && age >= 0 && age < ASIDE_INFLIGHT_WINDOW_MS) continue;
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    if (!entry.startsWith(stagingPrefix) || entry === ownStagingName) continue;
    let leftover: Stats;
    try {
      leftover = await stat(path);
    } catch {
      continue;
    }
    if (leftover.mtimeMs > stagingCutoff) continue;
    await rm(path, { force: true }).catch(() => undefined);
  }
}
