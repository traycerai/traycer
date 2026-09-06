import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS,
  cliScopedFileLockAgeMs,
  probeCliScopedFileLock,
  probeCliScopedFileLockArbitration,
  type CliLockMetadata,
  type CliScopedFileLockArbitration,
} from "../store/cli-lock";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "./issues";

// The progress-marker lock as a doctor probe. `host update` takes a short
// cross-process lock beside `update-progress.json` around each conditional
// write of the marker (create / replace / clear), waits a bounded time for
// it, and answers `failed` for a write it could not make. The lock is held
// for one write - milliseconds, never across a download or a wait - so a
// holder that is still there on a second read is not a writer in flight:
// it is a hung updater, or a lock whose holder cannot be verified and so is
// never broken by the acquisition path. Either way every later update's
// marker step fails, and the only artifact that explains it is this file.
//
// A STALE lock is not a fault by itself: a holder that has exited, a pid
// that was recycled, and an empty file past its grace window are all broken
// by the next acquisition on that evidence. What makes a stale lock a fault
// is a break-arbitration file (`<lock>.break`) that the acquisition cannot
// get past - a breaker that is alive or unverifiable, or a file dated in the
// future - so the probe reads that file too before it stays silent.
//
// Read-only. Doctor never breaks or removes either file: the acquisition
// path owns that, under its own arbitration, and only on positive evidence.

/**
 * How long the holder must still be there on the second read. Far above a
 * conditional write's hold time (a rename and a `link` / `wx` create), far
 * below the writer's own 2 s bounded wait.
 */
export const MARKER_LOCK_RECHECK_DELAY_MS = 250;

export interface ProbeUpdateMarkerLockOptions {
  /** `hostUpdateProgressMarkerLockPath(environment)` - the file the writer locks. */
  readonly lockPath: string;
  /** Injected so a test does not sleep; the engine passes a real timer. */
  readonly delay: (ms: number) => Promise<void>;
}

/**
 * `null` when there is nothing to say: no lock; a lock that was gone,
 * re-taken, or only just taken by the second read (a writer in flight); an
 * empty or corrupt file inside its grace window; or a stale lock the next
 * acquisition will break. An issue for a holder that is still running or
 * cannot be verified, for a stale lock whose break arbitration is wedged,
 * and for a file that cannot be read.
 */
export async function probeUpdateMarkerLock(
  opts: ProbeUpdateMarkerLockOptions,
): Promise<DoctorIssue | null> {
  const first = await probeCliScopedFileLock(opts.lockPath);
  if (first.kind === "absent") return null;
  if (first.kind === "read-error") return unreadableIssue(opts.lockPath, null);
  await opts.delay(MARKER_LOCK_RECHECK_DELAY_MS);
  const second = await probeCliScopedFileLock(opts.lockPath);
  if (second.kind === "absent") return null;
  if (second.kind === "read-error") return unreadableIssue(opts.lockPath, null);

  if (second.kind === "held") {
    // Arrived, or released and re-taken, between the reads: a moving lock.
    if (
      first.kind !== "held" ||
      first.holder.pid !== second.holder.pid ||
      first.holder.token !== second.holder.token
    ) {
      return null;
    }
    switch (second.liveness) {
      case "alive-same":
        return heldIssue(opts.lockPath, second.holder, "live");
      case "indeterminate":
        return heldIssue(opts.lockPath, second.holder, "unverifiable");
      case "dead":
      case "alive-different":
        return staleLockIssue(opts.lockPath, second.holder);
    }
  }

  // Empty or corrupt on the second read. A holder mid-creation produces
  // exactly these bytes, so only a file past the acquisition path's grace
  // window is stale - and one dated in the future is not age-breakable at
  // all until that date plus the window.
  const ageMs = await cliScopedFileLockAgeMs(opts.lockPath);
  if (ageMs === null) return null;
  if (ageMs < -CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS) {
    return futureDatedIssue(opts.lockPath, ageMs);
  }
  if (ageMs < CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS) return null;
  return staleLockIssue(opts.lockPath, null);
}

/**
 * A stale canonical lock is silent unless the arbitration behind it is
 * wedged - then the next acquisition cannot break it, however stale.
 */
async function staleLockIssue(
  lockPath: string,
  holder: CliLockMetadata | null,
): Promise<DoctorIssue | null> {
  const arbitration = await probeCliScopedFileLockArbitration(lockPath);
  if (arbitration.kind === "read-error") {
    return unreadableIssue(lockPath, `${lockPath}.break`);
  }
  if (arbitration.kind === "held") {
    return unbreakableIssue(lockPath, holder, arbitration);
  }
  // A free arbitration is necessary, not sufficient: breaking a stale lock
  // unlinks it, and taking the arbitration creates a file beside it, and
  // neither is possible in a directory this user cannot write. The negative
  // is asserted outright (a non-writable directory definitely cannot be
  // unlinked from); the positive is not a promise about every sticky bit or
  // ACL, only the absence of this one concrete cause.
  const dir = dirname(lockPath);
  const writable = await access(dir, fsConstants.W_OK).then(
    () => true,
    () => false,
  );
  return writable ? null : directoryNotWritableIssue(lockPath, holder, dir);
}

function directoryNotWritableIssue(
  lockPath: string,
  holder: CliLockMetadata | null,
  dir: string,
): DoctorIssue {
  const stale =
    holder === null
      ? `an empty or corrupt file past the ${String(CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS)} ms grace window`
      : `left by ${describeHolder(holder)}, which has exited or whose pid now belongs to another process`;
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
    severity: "warning",
    title:
      "Host update progress-marker lock is stale but its directory is not writable",
    message: `The host update progress-marker lock at ${lockPath} is stale (${stale}), but its directory ${dir} is not writable by this user, so no update can unlink the stale lock or create the break-arbitration file beside it. ${CONSEQUENCE} Restore write access to ${dir} for the user that runs 'traycer host update'; the stale lock is then broken by the next update on its own.`,
    fixAction: null,
    terminalCommand: null,
    details: {
      lockPath,
      holder,
      directory: dir,
      cause: "directory-not-writable",
    },
  };
}

function describeHolder(holder: CliLockMetadata): string {
  return `pid ${String(holder.pid)} (${holder.reason}, since ${holder.startedAt})`;
}

const CONSEQUENCE =
  "While it stays, 'traycer host update' cannot publish, update or clear its progress marker and reports that step as failed after a short wait.";

function heldIssue(
  lockPath: string,
  holder: CliLockMetadata,
  liveness: "live" | "unverifiable",
): DoctorIssue {
  const who = describeHolder(holder);
  const message =
    liveness === "live"
      ? `The host update progress-marker lock at ${lockPath} is held by ${who}, still running across two reads ${String(MARKER_LOCK_RECHECK_DELAY_MS)} ms apart; it guards one write and is normally held for milliseconds. ${CONSEQUENCE} If that process is a hung updater, stop it - the lock is released with the process.`
      : `The host update progress-marker lock at ${lockPath} is held by ${who}, whose identity cannot be verified (no creation stamp in the lock, or a probe this platform could not answer), so no update will break it. ${CONSEQUENCE} If no updater is running, remove the file.`;
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_HELD,
    severity: "warning",
    title:
      liveness === "live"
        ? "Host update progress-marker lock is held by a running process"
        : "Host update progress-marker lock is held by an unverifiable holder",
    message,
    fixAction: null,
    terminalCommand: null,
    details: {
      lockPath,
      holder,
      liveness: liveness === "live" ? "alive-same" : "indeterminate",
    },
  };
}

function unbreakableIssue(
  lockPath: string,
  holder: CliLockMetadata | null,
  arbitration: Extract<CliScopedFileLockArbitration, { kind: "held" }>,
): DoctorIssue {
  const breakPath = `${lockPath}.break`;
  const stale =
    holder === null
      ? `an empty or corrupt file past the ${String(CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS)} ms grace window`
      : `left by ${describeHolder(holder)}, which has exited or whose pid now belongs to another process`;
  const breaker =
    arbitration.breaker === null
      ? "a breaker record that could not be parsed"
      : `pid ${String(arbitration.breaker.pid)} (since ${arbitration.breaker.startedAt})`;
  const why =
    arbitration.cause === "breaker-live"
      ? `is held by ${breaker}, which is still running`
      : arbitration.cause === "breaker-unverifiable"
        ? `is held by ${breaker}, whose identity cannot be verified, so no contender will recover it`
        : `is dated in the future (${breaker}) and will not be recovered until that time has passed`;
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
    severity: "warning",
    title: "Host update progress-marker lock is stale but cannot be broken",
    message: `The host update progress-marker lock at ${lockPath} is stale (${stale}), but the break-arbitration file beside it, ${breakPath}, ${why}. Every acquisition has to take that file before it may break a stale lock, so none can. ${CONSEQUENCE} If no updater is running, remove ${breakPath}; the stale lock is then broken by the next update on its own.`,
    fixAction: null,
    terminalCommand: null,
    details: {
      lockPath,
      breakPath,
      holder,
      breaker: arbitration.breaker,
      cause: arbitration.cause,
    },
  };
}

function futureDatedIssue(lockPath: string, ageMs: number): DoctorIssue {
  const untilMs = -ageMs + CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS;
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
    severity: "warning",
    title: "Host update progress-marker lock is empty and dated in the future",
    message: `The host update progress-marker lock at ${lockPath} is an empty or corrupt file whose modification time is about ${String(Math.round(-ageMs / 1000))} s in the future (the clock stepped backwards after it was written). An empty lock is broken only once it is ${String(CLI_SCOPED_FILE_LOCK_EMPTY_GRACE_MS)} ms old, so this one will not be broken for another ${String(Math.round(untilMs / 1000))} s. ${CONSEQUENCE} If no updater is running, remove the file.`,
    fixAction: null,
    terminalCommand: null,
    details: { lockPath, ageMs },
  };
}

function unreadableIssue(
  lockPath: string,
  breakPath: string | null,
): DoctorIssue {
  const file = breakPath ?? lockPath;
  const role =
    breakPath === null
      ? "'traycer host update' takes this lock around each write of its progress marker; a lock it cannot read is one it cannot hold, and the marker step of every update then reports failed."
      : `The lock at ${lockPath} is stale, and every acquisition must read this arbitration file before it may break a stale lock; one it cannot read leaves the stale lock in place, and the marker step of every update then reports failed.`;
  return {
    code: DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNREADABLE,
    severity: "warning",
    title:
      breakPath === null
        ? "Host update progress-marker lock cannot be read"
        : "Host update progress-marker lock's break-arbitration file cannot be read",
    message: `The file ${file} exists but could not be read. ${role} Check the file's permissions and ownership.`,
    fixAction: null,
    terminalCommand: null,
    details: { lockPath, breakPath },
  };
}
