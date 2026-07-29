import type { Environment } from "../runner/environment";
import { writeFile } from "node:fs/promises";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { cliLockPath, ensureCliInstallHomeDir } from "./paths";
import {
  acquireLock,
  withLock,
  type AcquireLockOptions,
  type LockHandle,
  type LockMetadata,
} from "@traycer-clients/shared/host-lock/cross-process-lock";

// Re-exported for existing callers (`host/busy-check.ts`, service
// controllers, doctor) - the liveness probe lives in
// `@traycer-clients/shared/host-lock/process-identity` alongside the
// start-time/identity logic it shares with the owner-tokened temp sweep,
// but this stays the canonical CLI import path for plain liveness checks.
export { isProcessAlive } from "./process-identity";

// Cross-process lock for CLI mutations (host install/update/uninstall,
// CLI self-upgrade promotion, manifest mutations). The lock-file protocol
// itself - open with O_CREAT|O_EXCL, holder identity, only-positive-
// evidence breaking, the `.break` arbitration sub-lock - lives in
// `@traycer-clients/shared/host-lock/cross-process-lock` (Host Update
// Layer Redesign Tech Plan, "cli-lock" rule 3: desktop main implements the
// IDENTICAL protocol around its own SMAppService critical sections, so the
// mechanics are singular and both sides consume the same module). This
// file is the CLI's thin wrapper: it resolves the environment-scoped lock
// path and converts the shared module's discriminated "busy" outcome into
// this package's `CliError` throwing convention.
//
// Lock files are per-environment - there is no reason a dev-slot and a
// prod-slot CLI mutation should serialise against each other, since they
// touch disjoint directories.

export type CliLockMetadata = LockMetadata;
export type CliLockHandle = LockHandle;

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

function lockBusyError(path: string, holder: LockMetadata | null): Error {
  return cliError({
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

export async function acquireCliLock(
  opts: AcquireCliLockOptions,
): Promise<CliLockHandle> {
  await ensureCliInstallHomeDir(opts.environment);
  const path = cliLockPath(opts.environment);
  const outcome = await acquireLock({
    lockPath: path,
    reason: opts.reason,
    waitMs: opts.waitMs,
    pollIntervalMs: opts.pollIntervalMs,
  });
  if (outcome.kind === "busy") {
    throw lockBusyError(path, outcome.holder);
  }
  return outcome.handle;
}

export interface AcquireCliLockAtPathTestOptions {
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

// Test-only entry point that contends for a lock at an ARBITRARY path,
// bypassing `cliLockPath`'s real `~/.traycer` resolution entirely. The
// caller is responsible for ensuring the parent directory already exists
// (a real `acquireCliLock` call does this via `ensureCliInstallHomeDir`; a
// test sandbox typically already has one from `mkdtemp`). Production code
// never calls this.
export async function __acquireCliLockAtPathForTest(
  path: string,
  opts: AcquireCliLockAtPathTestOptions,
): Promise<CliLockHandle> {
  const lockOpts: AcquireLockOptions = {
    lockPath: path,
    reason: opts.reason,
    waitMs: opts.waitMs,
    pollIntervalMs: opts.pollIntervalMs,
  };
  const outcome = await acquireLock(lockOpts);
  if (outcome.kind === "busy") {
    throw lockBusyError(path, outcome.holder);
  }
  return outcome.handle;
}

// `withCliLock(opts, fn)` - acquire, run fn, release in finally. Catches
// nothing on the inner function; the lock is released either way.
export async function withCliLock<T>(
  opts: AcquireCliLockOptions,
  fn: (handle: CliLockHandle) => Promise<T>,
): Promise<T> {
  await ensureCliInstallHomeDir(opts.environment);
  const path = cliLockPath(opts.environment);
  const outcome = await withLock(
    {
      lockPath: path,
      reason: opts.reason,
      waitMs: opts.waitMs,
      pollIntervalMs: opts.pollIntervalMs,
    },
    async (handle) => {
      // Test-only process boundary: the desktop lock integration test needs
      // to distinguish a spawned CLI from one which has actually acquired
      // this shared lock. Production never sets this variable.
      const acquiredMarker = process.env.TRAYCER_CLI_LOCK_ACQUIRED_MARKER;
      if (acquiredMarker !== undefined) {
        await writeFile(acquiredMarker, "");
      }
      return fn(handle);
    },
  );
  if (outcome.kind === "busy") {
    throw lockBusyError(path, outcome.holder);
  }
  return outcome.result;
}
