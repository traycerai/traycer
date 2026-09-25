import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { isErrnoException } from "../runner/errors";
import {
  hostLogBackupPath,
  hostLogOldestBackupPath,
  hostLogPath,
} from "../store/paths";
import { publishedHostProcessGone, readHostPidMetadata } from "./pid-metadata";

/**
 * Generation rotation for `host.log`: `host.log` -> `host.log.1` ->
 * `host.log.2`, oldest deleted.
 *
 * `host.log` is append-only from every writer - the supervisor's bootstrap
 * markers, the host's stdio fd handed to `spawn`, and the host's own file
 * logger - so nothing here truncates it. That leaves two problems, and this
 * module is the one answer to both:
 *
 *   - **Unbounded growth across restarts.** A host that dies before its own
 *     rotator fires leaves whatever it grew; a start under the cap would keep
 *     appending to it.
 *   - **Forensics destroyed on purge.** `traycer host uninstall --all` deletes
 *     the log outright, and `make dev-desktop` runs exactly that on every Ctrl-C
 *     teardown - so the session you actually want to investigate is routinely
 *     gone by the time you look.
 *
 * ## The set is the HOST'S set, and the rotation is a shift
 *
 * The host's own logger rotates the same file in-process
 * (`traycer-host/src/bootstrap/host-logger.ts`: at 10 MB it shifts
 * `host.log.1` onto `host.log.2` and `host.log` onto `host.log.1`, three files
 * in all). This module's rotations run against the same directory, so they
 * must move the same set the same way. An earlier version renamed `host.log`
 * straight onto `host.log.1`: every start of an oversized dead-host log then
 * destroyed the generation the host had just rotated out, and its `host.log.2`
 * went stale beside a `.1` it did not precede. Now the shift is the same as
 * the host's - `.1` moves onto `.2` (replacing it) and then `host.log` onto
 * `.1` - so a restart costs one generation at the far end, never the newest,
 * and a shift that cannot happen stops the rotation rather than paying with
 * the newest (see `shiftGenerations`). Two retained generations is the whole
 * design: a forensic trail across the previous sessions, not an archive.
 *
 * ## The cap is checked AT START, not continuously - and that is a real limit
 *
 * Be precise about what {@link MAX_HOST_LOG_BYTES} buys here: it bounds the log
 * **across restarts** at this module's threshold. Within a lifetime the host's
 * own rotator bounds it, and the start path never rotates under a live host
 * (the purge path runs after the host was stopped and is not pid-guarded).
 *
 * This is not laziness about the cost of a `stat` on the append path - it is a
 * correctness constraint. The supervisor hands the running host a long-lived
 * append **fd** for its stdout/stderr (`spawn(stdio:[ignore, fd, fd])`), while
 * the host's own logger writes to the same file BY PATH (`appendFileSync`). An
 * fd follows the inode across a `rename`; a path does not. So a rotation from
 * this process while the host is live would send the logger's lines to the new
 * `host.log` while the very same process's stdout kept flowing into
 * `host.log.1` - one session torn across two files, which is strictly worse for
 * forensics than a large file. Rotating before that fd is ever opened has no
 * such hazard.
 *
 * Best-effort by contract: rotation is a diagnostics nicety and must never block
 * a host start or an uninstall, so every entry point swallows its errors.
 */

// Matches the desktop perf log's cap (`perf-telemetry-writer.ts`), the one other
// rotating file Traycer writes.
export const MAX_HOST_LOG_BYTES = 5 * 1024 * 1024;

async function fileSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    // Missing (first start, or already purged) reads as empty - nothing to
    // rotate, and every caller treats that the same way.
    return 0;
  }
}

type MutationVerifier = () => Promise<void>;

const legacyMutationVerifier: MutationVerifier = async (): Promise<void> =>
  undefined;

async function removeQuietly(
  filePath: string,
  verifyMutationCapability: MutationVerifier,
): Promise<void> {
  // Keep authority failures outside the best-effort I/O catch. A failed
  // capability check is not a failed cleanup: it means this process must stop
  // changing the install tree immediately.
  await verifyMutationCapability();
  try {
    await rm(filePath, { force: true });
  } catch {
    // Best-effort contract: a purge must never throw into the caller.
  }
}

const REPLACE_EXISTING_CODES = new Set(["EACCES", "EEXIST", "EPERM"]);

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Move `logPath` onto `backupPath`, replacing whatever was there.
 *
 * Ordering matters: the rename is attempted FIRST, so a move that cannot
 * happen never destroys the evidence it was supposed to preserve. On POSIX that
 * single call atomically replaces the destination, so the old file is dropped
 * only once the new one is safely in place. Windows `rename` (`MoveFileExW`
 * with REPLACE_EXISTING) replaces an existing destination too, but can refuse
 * to (EPERM/EACCES/EEXIST: a handle held open on it, a read-only attribute),
 * so that (and only that) case falls back to moving the previous file aside,
 * which an open handle does not block, and retrying - by which point we
 * already know the destination exists and the source is intact. The displaced
 * file is restored if the retry fails, so an unrelated source/permission
 * failure cannot destroy the previous generation.
 */
async function rotate(
  logPath: string,
  backupPath: string,
  verifyMutationCapability: MutationVerifier,
): Promise<"rotated" | "skipped"> {
  await verifyMutationCapability();
  try {
    await rename(logPath, backupPath);
    return "rotated";
  } catch (cause) {
    const code = isErrnoException(cause) ? cause.code : null;
    if (
      typeof code !== "string" ||
      !REPLACE_EXISTING_CODES.has(code) ||
      !(await isRegularFile(backupPath))
    ) {
      return "skipped";
    }
  }

  const displacedBackupPath = `${backupPath}.replace-${randomUUID()}`;
  await verifyMutationCapability();
  try {
    await rename(backupPath, displacedBackupPath);
  } catch {
    return "skipped";
  }

  await verifyMutationCapability();
  try {
    await rename(logPath, backupPath);
  } catch {
    // If rollback itself is blocked, the prior evidence still survives at the
    // displaced path rather than being deleted. A successful rollback removes
    // that exceptional extra file and puts the destination back as it was.
    await verifyMutationCapability();
    try {
      await rename(displacedBackupPath, backupPath);
    } catch {
      // Best-effort contract: never block host start or uninstall.
    }
    return "skipped";
  }

  await removeQuietly(displacedBackupPath, verifyMutationCapability);
  return "rotated";
}

/**
 * The generation shift: `host.log.1` onto `host.log.2` (dropping the previous
 * `.2`), then `host.log` onto `host.log.1` - the host's own rotator's order.
 *
 * A shift that cannot happen stops the rotation, as the host's rotator does.
 * The alternative - moving `host.log` onto the `.1` that would not shift -
 * would destroy the NEWEST retained generation to clear the live log, which
 * inverts the one promise this module makes (the far end pays, never the
 * newest). Leaving the live log in place costs size at a start and leaves a
 * file behind at a purge, and both are reported as `skipped`. The first
 * move's own rollback keeps the previous `.2` intact when it fails.
 *
 * The order has one exposure, shared with the host's rotator: if the shift
 * succeeds and the second move then fails (the live log held open on
 * Windows), the previous `.2` is already gone and the old `.1` sits at `.2`.
 * That is the generation due for deletion; the next attempt finds no `.1`,
 * shifts nothing and moves `host.log` onto `.1`, so at most one generation
 * is lost, and it is the oldest. The result is still `skipped`: the live log
 * did not rotate.
 *
 * A missing `.1` is not a failure - there is nothing to shift, and a stale
 * `.2` beside it is left where it is rather than deleted for nothing.
 */
async function shiftGenerations(
  logPath: string,
  backupPath: string,
  oldestBackupPath: string,
  verifyMutationCapability: MutationVerifier,
): Promise<"rotated" | "skipped"> {
  if (await isRegularFile(backupPath)) {
    const shifted = await rotate(
      backupPath,
      oldestBackupPath,
      verifyMutationCapability,
    );
    if (shifted === "skipped") return "skipped";
  }
  return await rotate(logPath, backupPath, verifyMutationCapability);
}

/**
 * True when a host process is already recorded as live for this environment.
 *
 * Guards against an overlapping start rotating the log out from under a host
 * that is still running and still holds the append fd for it - the same
 * fd-follows-the-inode hazard described above, which would split the live
 * host's session across two inodes.
 */
async function hostIsLive(environment: Environment): Promise<boolean> {
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) return false;
  // Liveness and identity: a stopped host's pid recycled onto an unrelated
  // process is not a host holding this log's fd, and skipping the rotation
  // for it would let an oversized log of a stopped host grow unbounded. A
  // record this cannot prove gone (no stamp, a refused probe) keeps the
  // skip - the safe direction for a live host's session.
  return !publishedHostProcessGone(metadata);
}

/**
 * Shift `host.log` into the generations when it has grown past
 * {@link MAX_HOST_LOG_BYTES}. Called on the host-start path BEFORE the append fd
 * is opened, so growth is bounded across restarts and a start under the cap
 * keeps appending to the same file - two consecutive starts still land in one
 * log, which is what makes a restart's markers readable in context.
 *
 * Skipped entirely when a host is already live for this environment: that host
 * holds an open fd on the file, and rotating under it would tear its session in
 * half.
 */
export async function rotateHostLogIfOversized(
  environment: Environment,
): Promise<"rotated" | "skipped"> {
  const logPath = hostLogPath(environment);
  if ((await fileSize(logPath)) < MAX_HOST_LOG_BYTES) return "skipped";
  if (await hostIsLive(environment)) return "skipped";
  return await shiftGenerations(
    logPath,
    hostLogBackupPath(environment),
    hostLogOldestBackupPath(environment),
    legacyMutationVerifier,
  );
}

/**
 * Shift `host.log` into the generations unconditionally, for the runtime-purge
 * path (`host uninstall --all`). Purging must still clear the live log - an
 * orphan log left behind by an uninstall is its own surprise - but the session
 * it records is precisely the one worth keeping, and a dev teardown hits this
 * path many times a day. Rotating satisfies both: the runtime is purged, the
 * two generations survive, and they cannot accumulate.
 *
 * Not pid-guarded, unlike the start path: uninstall runs after the host has been
 * stopped, and a purge that silently left the log behind because a stale pid
 * file said "live" would defeat the point.
 */
export async function rotateHostLogForPurge(
  environment: Environment,
): Promise<"rotated" | "skipped"> {
  return await rotateHostLogForPurgeWithVerifier(
    environment,
    legacyMutationVerifier,
  );
}

/**
 * Capability-bound variant used by attempt-admitted uninstall. Every actual
 * rename or removal checks the still-live capability immediately beforehand;
 * authority loss is deliberately propagated rather than hidden by the
 * diagnostics best-effort contract.
 */
export async function rotateHostLogForPurgeWithVerifier(
  environment: Environment,
  verifyMutationCapability: MutationVerifier,
): Promise<"rotated" | "skipped"> {
  const logPath = hostLogPath(environment);
  if ((await fileSize(logPath)) === 0) {
    // Nothing worth keeping (absent, empty, or unreadable). Still drop a
    // zero-length file so the purge leaves no stragglers.
    await removeQuietly(logPath, verifyMutationCapability);
    return "skipped";
  }
  return await shiftGenerations(
    logPath,
    hostLogBackupPath(environment),
    hostLogOldestBackupPath(environment),
    verifyMutationCapability,
  );
}
