import { randomUUID } from "node:crypto";
import { rename, rm, stat, utimes, writeFile } from "node:fs/promises";

/**
 * Shared low-level filesystem helpers for the credentials-file token store
 * (primitives, lock, WAL sidecar). Kept in one place so the atomic-rename guard,
 * the errno reader, and the monotonic-mtime logic do not drift across the
 * modules that need them.
 */

/** The `code` of a Node errno-style error, or `null` when there isn't one. */
export function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

// Escalating mtime bumps for the set-and-verify below. A coarse-granularity
// filesystem (HFS+ 1s, some FAT 2s) truncates a sub-second-newer mtime back to
// the same tick, which the host's mtime-equality owner cache would read as
// "unchanged". Each step forces the next whole-second boundaries until the
// observed mtime is provably above the floor.
const MTIME_BUMP_STEPS_MS = [1000, 2000, 4000, 8000, 16000] as const;

/** The file's mtime in ms, or `0` when it is absent (ENOENT). */
export async function fileMtimeMsOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Ensures `path`'s mtime is strictly greater than `floorMs`, re-bumping across
 * coarse-filesystem granularity, and returns the landed mtime. Shared by the
 * write primitive (post-rename verify) and WAL recovery (replaying an
 * interrupted write's mtime guarantee), so both enforce it identically.
 */
export async function bumpMtimeAbove(
  path: string,
  floorMs: number,
): Promise<number> {
  for (const step of MTIME_BUMP_STEPS_MS) {
    const observed = (await stat(path)).mtimeMs;
    if (observed > floorMs) return observed;
    const bumped = new Date(floorMs + step);
    await utimes(path, bumped, bumped);
  }
  return (await stat(path)).mtimeMs;
}

// Windows filesystem filters (antivirus/indexers) can briefly hold a
// newly-written file open, so a `rename` over it fails transiently with
// EACCES/EBUSY/EPERM. Node's `rename` has no retry; a bounded one belongs at
// this persistence boundary. POSIX and non-transient failures surface at once.
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const TRANSIENT_WINDOWS_RENAME_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

export async function renameWithWindowsRetry(
  source: string,
  target: string,
  retryIndex: number,
): Promise<void> {
  try {
    await rename(source, target);
  } catch (err) {
    const code = errorCode(err);
    const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
    if (
      process.platform !== "win32" ||
      code === null ||
      !TRANSIENT_WINDOWS_RENAME_ERROR_CODES.has(code) ||
      retryDelay === undefined
    ) {
      throw err;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, retryDelay);
    });
    await renameWithWindowsRetry(source, target, retryIndex + 1);
  }
}

/**
 * Atomically writes `value` as pretty JSON: a per-write unique temp (so
 * concurrent writers never share a temp and clobber each other's staging), then
 * an atomic rename into place. The temp is removed if the write or rename
 * fails. `mode` sets the file permission bits on the temp.
 */
export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode,
    });
    await renameWithWindowsRetry(tmp, path, 0);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
