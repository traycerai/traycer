import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { isErrnoException } from "../runner/errors";
import { hostLogBackupPath, hostLogPath } from "../store/paths";
import { readHostPidMetadata } from "./pid-metadata";

/**
 * Single-generation rotation for `host.log`.
 *
 * `host.log` is append-only from every writer - the supervisor's bootstrap
 * markers, the host's stdio fd handed to `spawn`, and the host's own file
 * logger - so nothing ever truncates it. That leaves two problems, and this
 * module is the one answer to both:
 *
 *   - **Unbounded growth.** Nothing caps the file. A long-lived host retrying a
 *     failing provider can grow it without limit (`harness-runtime.ts` says as
 *     much in its own comment).
 *   - **Forensics destroyed on purge.** `traycer host uninstall --all` deletes
 *     the log outright, and `make dev-desktop` runs exactly that on every Ctrl-C
 *     teardown - so the session you actually want to investigate is routinely
 *     gone by the time you look.
 *
 * Rotating to a single `host.log.1` sibling addresses both without either
 * failure mode of the alternatives: it bounds the file (unlike pure appending)
 * and it preserves one previous generation (unlike deleting/truncating). One
 * generation is the whole design - this is a forensic trail across ONE restart,
 * not an archive.
 *
 * ## The cap is checked AT START, not continuously - and that is a real limit
 *
 * Be precise about what {@link MAX_HOST_LOG_BYTES} buys: it bounds the log
 * **across restarts**, not *within* a single host's lifetime. A host that runs
 * for weeks can still grow `host.log` past the cap, and nothing here stops it.
 *
 * This is not laziness about the cost of a `stat` on the append path - it is a
 * correctness constraint. The supervisor hands the running host a long-lived
 * append **fd** for its stdout/stderr (`spawn(stdio:[ignore, fd, fd])`), while
 * the host's own logger writes to the same file BY PATH (`appendFileSync`). An
 * fd follows the inode across a `rename`; a path does not. So an in-process
 * rotation while the host is live would send the logger's lines to the new
 * `host.log` while the very same process's stdout kept flowing into
 * `host.log.1` - one session torn across two files, which is strictly worse for
 * forensics than a large file. Rotating before that fd is ever opened has no
 * such hazard.
 *
 * Making the cap a true within-lifetime bound therefore requires the supervisor
 * to stop sharing one file between the child's stdio fd and the path-writers
 * (give the host's stdio its own sink, or have the host reopen stdio after it
 * rotates). That is a larger change than this module, and deliberately out of
 * its scope.
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

async function removeQuietly(filePath: string): Promise<void> {
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
 * Move `logPath` onto `backupPath`, keeping exactly one generation.
 *
 * Ordering matters: the rename is attempted FIRST, so a rotation that cannot
 * happen never destroys the evidence it was supposed to preserve. On POSIX that
 * single call atomically replaces the destination, so the old backup is dropped
 * only once the new one is safely in place. Windows `rename` refuses an existing
 * destination, so that (and only that) case falls back to moving the previous
 * backup aside and retrying - by which point we already know the destination
 * exists and the source is intact. The displaced backup is restored if the
 * retry fails, so an unrelated source/permission failure cannot destroy the
 * previous generation.
 */
async function rotate(
  logPath: string,
  backupPath: string,
): Promise<"rotated" | "skipped"> {
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
  try {
    await rename(backupPath, displacedBackupPath);
  } catch {
    return "skipped";
  }

  try {
    await rename(logPath, backupPath);
  } catch {
    // If rollback itself is blocked, the prior evidence still survives at the
    // displaced path rather than being deleted. A successful rollback removes
    // that exceptional extra file and restores the normal single generation.
    try {
      await rename(displacedBackupPath, backupPath);
    } catch {
      // Best-effort contract: never block host start or uninstall.
    }
    return "skipped";
  }

  await removeQuietly(displacedBackupPath);
  return "rotated";
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
  try {
    // Signal 0 performs the permission/existence check without delivering a
    // signal: it throws ESRCH when no such process exists.
    process.kill(metadata.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate `host.log` to `host.log.1` when it has grown past
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
  return await rotate(logPath, hostLogBackupPath(environment));
}

/**
 * Rotate `host.log` to `host.log.1` unconditionally, for the runtime-purge path
 * (`host uninstall --all`). Purging must still clear the live log - an orphan
 * log left behind by an uninstall is its own surprise - but the session it
 * records is precisely the one worth keeping, and a dev teardown hits this path
 * many times a day. Rotating satisfies both: the runtime is purged, one
 * generation survives, and it cannot accumulate.
 *
 * Not pid-guarded, unlike the start path: uninstall runs after the host has been
 * stopped, and a purge that silently left the log behind because a stale pid
 * file said "live" would defeat the point.
 */
export async function rotateHostLogForPurge(
  environment: Environment,
): Promise<"rotated" | "skipped"> {
  const logPath = hostLogPath(environment);
  if ((await fileSize(logPath)) === 0) {
    // Nothing worth keeping (absent, empty, or unreadable). Still drop a
    // zero-length file so the purge leaves no stragglers.
    await removeQuietly(logPath);
    return "skipped";
  }
  return await rotate(logPath, hostLogBackupPath(environment));
}
