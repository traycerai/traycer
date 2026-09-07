import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { isErrnoException } from "../runner/errors";
import { hostLogBackupPath, hostLogPath } from "../store/paths";
import { publishedHostProcessGone, readHostPidMetadata } from "./pid-metadata";

/** Rotate `host.log` once per generation. Do not interpolate this path into other logs. */

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
  // Keep authority failures outside the best-effort I/O catch.
  // A failed capability check is not a failed cleanup: it means this process must stop changing the install tree immediately.
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

/** Move `logPath` onto `backupPath`, keeping exactly one generation. Ordering matters: the rename is attempted FIRST, so a rotation that cannot happen never destroys the evidence it was supposed to preserve. */
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
    // If rollback itself is blocked, the prior evidence still survives at the displaced path rather than being deleted.
    // A successful rollback removes that exceptional extra file and restores the normal single generation.
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

/** True when a host process is already recorded as live for this environment. Guards against an overlapping start rotating the log out from under a host that is still running and still holds the append fd for it - the same fd-follows-the-inode hazard described above, which would split the live host's session across two inodes. */
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

/** Rotate `host.log` to `host.log.1` when it has grown past {@link MAX_HOST_LOG_BYTES}. Called on the host-start path BEFORE the append fd is opened, so growth is bounded across restarts and a start under the cap keeps appending to the same file - two consecutive starts still land in one log, which is what makes a restart's markers readable in context. */
export async function rotateHostLogIfOversized(
  environment: Environment,
): Promise<"rotated" | "skipped"> {
  const logPath = hostLogPath(environment);
  if ((await fileSize(logPath)) < MAX_HOST_LOG_BYTES) return "skipped";
  if (await hostIsLive(environment)) return "skipped";
  return await rotate(
    logPath,
    hostLogBackupPath(environment),
    legacyMutationVerifier,
  );
}

/** Rotate `host.log` to `host.log.1` unconditionally, for the runtime-purge path (`host uninstall --all`). Purging must still clear the live log - an orphan log left behind by an uninstall is its own surprise - but the session it records is precisely the one worth keeping, and a dev teardown hits this path many times a day. */
export async function rotateHostLogForPurge(
  environment: Environment,
): Promise<"rotated" | "skipped"> {
  return await rotateHostLogForPurgeWithVerifier(
    environment,
    legacyMutationVerifier,
  );
}

/** Capability-bound variant used by attempt-admitted uninstall. Every actual rename or removal checks the still-live capability immediately beforehand; authority loss is deliberately propagated rather than hidden by the diagnostics best-effort contract. */
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
  return await rotate(
    logPath,
    hostLogBackupPath(environment),
    verifyMutationCapability,
  );
}
