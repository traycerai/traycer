import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
import { cliLockPath, ensureCliHomeDir } from "./paths";

// Cross-platform process-liveness probe. POSIX uses `process.kill(pid, 0)`;
// Windows uses `tasklist /FI "PID eq <pid>" /NH /FO CSV` and asserts the
// CSV body is non-empty. Exported so service controllers + doctor +
// installer all share one implementation.
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    let stdout: string;
    try {
      stdout = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      );
    } catch {
      // tasklist missing or refused - be conservative and treat the
      // PID as still held so we never break a lock we can't probe.
      return true;
    }
    // tasklist prints an `INFO: No tasks are running which match...`
    // line on stderr when nothing matches; stdout is empty. When a
    // match exists, stdout contains a CSV row with the binary name
    // and the same PID we asked about.
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return false;
    return trimmed.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = isErrnoException(err) ? err.code : null;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

// Cross-process lock for CLI mutations (host install/update/uninstall
// in NP-2+, CLI self-upgrade promotion, manifest mutations).
//
// Mechanism: open the lock file with O_CREAT | O_EXCL (Node `wx` flag).
// On EEXIST, parse the existing file's pid; if the pid is gone the
// holder crashed and we steal the lock. The poll loop is small and the
// lock file lives in the user's home so contention is naturally limited.
//
// Lock files are per-environment - there is no reason a dev-slot and a
// prod-slot CLI mutation should serialise against each other, since they
// touch disjoint directories.

export interface CliLockMetadata {
  readonly pid: number;
  readonly reason: string;
  readonly startedAt: string;
  readonly hostname: string | null;
  // Per-acquisition nonce so `release()` can verify it still owns the file
  // before unlinking (see `tryAcquireOnce`). `null` only for a lock written
  // by a pre-token CLI version - never written by this code.
  readonly token: string | null;
}

export interface CliLockHandle {
  readonly path: string;
  readonly metadata: CliLockMetadata;
  release(): Promise<void>;
}

export interface AcquireCliLockOptions {
  readonly environment: Environment;
  // What this lock holder is doing - written into the lock file for
  // observability ("install-host", "uninstall-host", etc.).
  readonly reason: string;
  // Max time to wait for the lock to free up. 0 → fail immediately on
  // contention. Defaults are *not* used here per project style; callers
  // must decide.
  readonly waitMs: number;
  // Poll interval while waiting. The runtime clamps below to a sane min.
  readonly pollIntervalMs: number;
}

const MIN_POLL_MS = 25;

// An empty or corrupt lock file means the holder created it with O_EXCL
// but died before writing its metadata - UNLESS a live holder is still
// mid-creation and simply hasn't written yet. Legitimate metadata writes
// land within milliseconds of the open(), so any empty lock file older
// than this grace window has no live owner and is safe to break.
const EMPTY_LOCK_GRACE_MS = 5000;

// `isProcessAlive` only proves *some* process currently owns the recorded
// PID, not that it's the same process that wrote the lock - the OS is free
// to recycle a PID onto an unrelated process once the original holder
// exits, and that impostor would otherwise be read as "alive" forever
// (silently for a same-user reuse, or via the EPERM conservative branch for
// a different-user reuse). This ceiling is the backstop: no matter how the
// PID check reads, a lock older than this is force-broken. Generous enough
// to cover a slow host install (no download timeout today) while still
// bounding a truly stuck lock to a tolerable wait.
const MAX_LOCK_AGE_MS = 10 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function hostnameSafe(): string | null {
  try {
    return osHostname();
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string | null {
  if (isErrnoException(err)) {
    return typeof err.code === "string" ? err.code : null;
  }
  return null;
}

async function readLockMetadata(path: string): Promise<CliLockMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
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
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.reason !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    return null;
  }
  return {
    pid: obj.pid,
    reason: obj.reason,
    startedAt: obj.startedAt,
    hostname: typeof obj.hostname === "string" ? obj.hostname : null,
    // Deliberately not required above alongside pid/reason/startedAt: a
    // lock written by a pre-token CLI version (e.g. mid self-upgrade with
    // mixed versions momentarily on disk) must still parse as a valid,
    // live-checkable holder rather than be swept as "corrupt" on the
    // 5-second empty-lock grace window.
    token: typeof obj.token === "string" ? obj.token : null,
  };
}

// Returns true if the holder process is alive. Delegates to the shared
// `isProcessAlive` helper so the POSIX `process.kill(pid, 0)` path and
// the Windows `tasklist` path stay in lock-step with the service
// controllers + doctor checks.
function holderAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  return isProcessAlive(pid);
}

// Age of the lock file in milliseconds, or null if it can no longer be
// stat'd (already swept by another process). Used only to decide whether
// an empty/corrupt lock file is a crashed holder vs. one mid-creation.
async function lockFileAgeMs(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

async function breakStaleLock(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

async function tryAcquireOnce(
  path: string,
  meta: CliLockMetadata,
): Promise<CliLockHandle | "held"> {
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (err) {
    if (errorCode(err) === "EEXIST") return "held";
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(meta, null, 2));
  } catch (err) {
    try {
      await handle.close();
    } catch {
      // Best effort - we're already on the error path.
    }
    try {
      await unlink(path);
    } catch {
      // Best effort.
    }
    throw err;
  }
  let released = false;
  return {
    path,
    metadata: meta,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await handle.close();
      } catch {
        // Closing twice is a no-op for callers; ignore.
      }
      // Compare-and-delete: only unlink if the file still carries the token
      // this handle wrote. If a staleness check (this bug, or a future
      // false positive) ever broke this lock and someone else re-acquired
      // it while we were still alive, blindly unlinking here would delete
      // *their* lock out from under them. A file with no token at all is a
      // pre-token-version lock (never written by this code) - fall back to
      // the old unconditional unlink, since there is nothing to compare.
      try {
        const current = await readLockMetadata(path);
        if (
          current !== null &&
          current.token !== null &&
          current.token !== meta.token
        ) {
          return;
        }
        await unlink(path);
      } catch {
        // If the file already vanished (e.g. swept by another tool), that's fine.
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireCliLock(
  opts: AcquireCliLockOptions,
): Promise<CliLockHandle> {
  await ensureCliHomeDir(opts.environment);
  const path = cliLockPath(opts.environment);
  const meta: CliLockMetadata = {
    pid: process.pid,
    reason: opts.reason,
    startedAt: nowIso(),
    hostname: hostnameSafe(),
    token: randomUUID(),
  };
  const pollMs = Math.max(MIN_POLL_MS, opts.pollIntervalMs);
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  while (true) {
    const attempt = await tryAcquireOnce(path, meta);
    if (attempt !== "held") return attempt;
    const holder = await readLockMetadata(path);
    if (holder !== null) {
      // Age is checked regardless of what the PID check concludes - a
      // recycled-PID impostor would otherwise be read as "alive" forever
      // (see MAX_LOCK_AGE_MS above), so no amount of PID-liveness confidence
      // exempts a lock from this ceiling. `startedAt` is holder-supplied,
      // not a trusted clock - an unparseable or future value (corruption,
      // clock skew) would otherwise make ageMs NaN or negative, which never
      // satisfies `>=` and silently defeats the ceiling. Fall back to the
      // lock file's own mtime in that case, since the filesystem - not the
      // holder - controls that timestamp.
      const now = Date.now();
      const startedAtMs = new Date(holder.startedAt).getTime();
      const ageMs =
        Number.isFinite(startedAtMs) && startedAtMs <= now
          ? now - startedAtMs
          : await lockFileAgeMs(path);
      if (
        !holderAlive(holder.pid) ||
        ageMs === null ||
        ageMs >= MAX_LOCK_AGE_MS
      ) {
        await breakStaleLock(path);
        continue;
      }
    } else {
      // Empty or corrupt lock file - no PID to probe. A crashed holder
      // that died between open() and writeFile() leaves exactly this, and
      // it can never self-recover via the PID path above. Break it once it
      // has aged past the grace window, so we don't steal a lock from a
      // live holder still in the open()->writeFile() gap.
      const ageMs = await lockFileAgeMs(path);
      if (ageMs === null || ageMs >= EMPTY_LOCK_GRACE_MS) {
        await breakStaleLock(path);
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw cliError({
        code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
        message:
          holder === null
            ? `another traycer CLI mutation is in progress (lock=${path})`
            : `another traycer CLI mutation is in progress (lock=${path}, holder.pid=${holder.pid}, reason=${holder.reason}, since=${holder.startedAt})`,
        details: {
          lockPath: path,
          holder,
        },
        exitCode: 75, // EX_TEMPFAIL - caller may retry
      });
    }
    await sleep(pollMs);
  }
}

// `withCliLock(opts, fn)` - acquire, run fn, release in finally. Catches
// nothing on the inner function; the lock is released either way.
export async function withCliLock<T>(
  opts: AcquireCliLockOptions,
  fn: (handle: CliLockHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireCliLock(opts);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}
