import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
import { cliLockPath, ensureCliInstallHomeDir } from "./paths";
import {
  readProcessStartTimeMs,
  verifyProcessIdentity,
} from "./process-identity";

// Re-exported for existing callers (`host/busy-check.ts`, service
// controllers, doctor) - the liveness probe now lives in
// `process-identity.ts` alongside the start-time/identity logic it shares
// with the owner-tokened temp sweep, but this stays the canonical import
// path for plain liveness checks.
export { isProcessAlive } from "./process-identity";

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
  // The holder process's OS start time (milliseconds since epoch,
  // best-effort) - distinct from `startedAt` above, which is when the
  // *lock* was acquired. Lets a contender positively confirm "still the
  // same process" rather than "some process is alive at this pid" (the OS
  // is free to recycle a pid onto an unrelated process). `null` when the
  // platform probe failed at write time, or for a lock written by a
  // pre-hardening CLI version - never written by this code otherwise.
  readonly processStartedAtMs: number | null;
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
    // Same tolerance as `token` above: a lock written by a pre-hardening
    // CLI version has no identity field at all - it must still parse as a
    // live-checkable holder, just with an unverifiable identity (handled
    // by `verifyProcessIdentity` returning "indeterminate", never treated
    // as corrupt).
    processStartedAtMs:
      typeof obj.processStartedAtMs === "number"
        ? obj.processStartedAtMs
        : null,
  };
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
  await ensureCliInstallHomeDir(opts.environment);
  const path = cliLockPath(opts.environment);
  const meta: CliLockMetadata = {
    pid: process.pid,
    reason: opts.reason,
    startedAt: nowIso(),
    hostname: hostnameSafe(),
    token: randomUUID(),
    processStartedAtMs: readProcessStartTimeMs(process.pid),
  };
  const pollMs = Math.max(MIN_POLL_MS, opts.pollIntervalMs);
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  while (true) {
    const attempt = await tryAcquireOnce(path, meta);
    if (attempt !== "held") return attempt;
    const holder = await readLockMetadata(path);
    if (holder !== null) {
      // Only positive evidence permits breaking a lock with a parsed
      // holder record: the holder's pid is positively dead, or a fresh
      // start-time read positively mismatches the recorded identity (a
      // recycled pid). Indeterminate cases - a liveness-probe failure, or
      // a legacy lock with no recorded process-start-time - wait
      // regardless of age; a wedge is strictly safer than concurrent
      // mutation of the install/staged tree. There is deliberately no age
      // ceiling here any more (see the Host Update Layer Redesign Tech
      // Plan's "cli-lock" section) - a genuinely alive, genuinely
      // identity-verified holder is never broken out from under itself no
      // matter how long its operation takes.
      const identity = verifyProcessIdentity({
        pid: holder.pid,
        startedAtMs: holder.processStartedAtMs,
      });
      if (identity === "dead" || identity === "alive-different") {
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
