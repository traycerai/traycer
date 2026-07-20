import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import {
  readProcessStartTimeMs,
  verifyProcessIdentity,
} from "./process-identity";

// Desktop-held implementation of the CLI's `cli-lock` file protocol (Host
// Update Layer Redesign Tech Plan, "cli-lock" rule 3: "Electron main
// implements the identical lock protocol (same file, desktop PID +
// start-time identity)"). This is a deliberate, mechanism-for-mechanism
// port of `clients/traycer-cli/src/store/cli-lock.ts` - that module is
// CLI-internal and this ticket must not modify `clients/traycer-cli/`, so
// the desktop side carries its own copy that reads/writes the SAME lock
// file (`cliLockPath(environment)`) using the SAME JSON shape
// (`DesktopCliLockMetadata` below is wire-identical to the CLI's
// `CliLockMetadata`), so a CLI-owned mutation and a desktop-held section
// exclude each other via ordinary O_CREAT|O_EXCL contention on one file.
//
// Deliberate API difference from the CLI's `acquireCliLock`: that function
// THROWS a `CliError` on deadline. This module instead returns a
// discriminated `AcquireDesktopCliLockOutcome` so `HostController` can
// implement its own bounded-retry-then-classify contract (automatic intents
// reschedule silently; manual intents resolve a "deferred" outcome;
// `convergeReady` resolves a gate failure) uniformly across both a CLI
// subprocess's `E_CLI_LOCK_BUSY`/`E_HOST_BUSY` exit and a desktop-held
// section's own busy result, without parsing a thrown error's shape.

export interface DesktopCliLockMetadata {
  readonly pid: number;
  readonly reason: string;
  readonly startedAt: string;
  readonly hostname: string | null;
  readonly token: string | null;
  readonly processStartedAtMs: number | null;
}

export interface DesktopCliLockHandle {
  readonly path: string;
  readonly metadata: DesktopCliLockMetadata;
  release(): Promise<void>;
}

export interface AcquireDesktopCliLockOptions {
  readonly lockPath: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

export type AcquireDesktopCliLockOutcome =
  | { readonly kind: "acquired"; readonly handle: DesktopCliLockHandle }
  | { readonly kind: "busy"; readonly holder: DesktopCliLockMetadata | null };

const MIN_POLL_MS = 25;
const EMPTY_LOCK_GRACE_MS = 5000;
const BREAK_LOCK_AGE_GRACE_MS = 2000;

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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function errorCode(err: unknown): string | null {
  if (isErrnoException(err)) {
    return typeof err.code === "string" ? err.code : null;
  }
  return null;
}

type LockRead =
  | { readonly kind: "present"; readonly raw: string }
  | { readonly kind: "absent" }
  | { readonly kind: "read-error" };

async function readLockRaw(path: string): Promise<LockRead> {
  try {
    return { kind: "present", raw: await readFile(path, "utf8") };
  } catch (err) {
    return errorCode(err) === "ENOENT"
      ? { kind: "absent" }
      : { kind: "read-error" };
  }
}

function parseLockMetadata(raw: string): DesktopCliLockMetadata | null {
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
    token: typeof obj.token === "string" ? obj.token : null,
    processStartedAtMs:
      typeof obj.processStartedAtMs === "number"
        ? obj.processStartedAtMs
        : null,
  };
}

async function lockFileAgeMs(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

// ---- Break-arbitration sub-lock (mirrors the CLI's `<lockPath>.break`) ----

interface BreakLockPayload {
  readonly pid: number;
  readonly startedAt: string;
  readonly processStartedAtMs: number | null;
  readonly token: string;
}

function breakLockPathFor(path: string): string {
  return `${path}.break`;
}

function parseBreakLockPayload(raw: string): BreakLockPayload | null {
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
    typeof obj.startedAt !== "string" ||
    typeof obj.token !== "string"
  ) {
    return null;
  }
  return {
    pid: obj.pid,
    startedAt: obj.startedAt,
    processStartedAtMs:
      typeof obj.processStartedAtMs === "number"
        ? obj.processStartedAtMs
        : null,
    token: obj.token,
  };
}

async function createBreakLockFile(
  breakLockPath: string,
  payload: BreakLockPayload,
): Promise<"created" | "exists"> {
  let handle: FileHandle;
  try {
    handle = await open(breakLockPath, "wx", 0o600);
  } catch (err) {
    if (errorCode(err) === "EEXIST") return "exists";
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2));
  } finally {
    await handle.close().catch(() => undefined);
  }
  return "created";
}

async function tryRecoverCrashedBreakLock(
  breakLockPath: string,
): Promise<boolean> {
  const read = await readLockRaw(breakLockPath);
  if (read.kind !== "present") return false;
  const payload = parseBreakLockPayload(read.raw);
  if (payload !== null) {
    const identity = verifyProcessIdentity({
      pid: payload.pid,
      startedAtMs: payload.processStartedAtMs,
    });
    if (identity !== "dead" && identity !== "alive-different") return false;
  }
  const ageMs = await lockFileAgeMs(breakLockPath);
  if (ageMs === null || ageMs < BREAK_LOCK_AGE_GRACE_MS) return false;
  await unlink(breakLockPath).catch(() => undefined);
  return true;
}

type AcquireBreakLockOutcome =
  | { readonly kind: "acquired"; readonly token: string }
  | { readonly kind: "busy" };

async function acquireBreakLock(
  path: string,
): Promise<AcquireBreakLockOutcome> {
  const breakLockPath = breakLockPathFor(path);
  const token = randomUUID();
  const payload: BreakLockPayload = {
    pid: process.pid,
    startedAt: nowIso(),
    processStartedAtMs: readProcessStartTimeMs(process.pid),
    token,
  };
  if ((await createBreakLockFile(breakLockPath, payload)) === "created") {
    return { kind: "acquired", token };
  }
  if (!(await tryRecoverCrashedBreakLock(breakLockPath))) {
    return { kind: "busy" };
  }
  const retry = await createBreakLockFile(breakLockPath, payload);
  return retry === "created" ? { kind: "acquired", token } : { kind: "busy" };
}

async function releaseBreakLock(path: string, token: string): Promise<void> {
  const breakLockPath = breakLockPathFor(path);
  const read = await readLockRaw(breakLockPath);
  if (read.kind !== "present") return;
  const payload = parseBreakLockPayload(read.raw);
  if (payload !== null && payload.token !== token) return;
  await unlink(breakLockPath).catch(() => undefined);
}

type BreakStaleLockOutcome =
  "broke" | "arbitration-busy" | "aborted" | "unlink-failed";

async function breakStaleLock(
  path: string,
  decisionRaw: string,
): Promise<BreakStaleLockOutcome> {
  const acquired = await acquireBreakLock(path);
  if (acquired.kind === "busy") return "arbitration-busy";
  try {
    const read = await readLockRaw(path);
    if (read.kind !== "present" || read.raw !== decisionRaw) {
      return "aborted";
    }
    try {
      await unlink(path);
    } catch {
      return "unlink-failed";
    }
    return "broke";
  } finally {
    await releaseBreakLock(path, acquired.token);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquireOnce(
  path: string,
  meta: DesktopCliLockMetadata,
): Promise<DesktopCliLockHandle | "held"> {
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
      // Compare-and-delete: unlink ONLY on positive proof this handle still
      // owns the file.
      const read = await readLockRaw(path);
      if (read.kind === "read-error" || read.kind === "absent") {
        return;
      }
      const current = parseLockMetadata(read.raw);
      if (
        current === null ||
        current.token === null ||
        current.token !== meta.token
      ) {
        return;
      }
      try {
        await unlink(path);
      } catch {
        // If the file already vanished (swept by another actor), that's fine.
      }
    },
  };
}

async function acquireLockAtPath(
  path: string,
  meta: DesktopCliLockMetadata,
  waitMs: number,
  pollIntervalMs: number,
): Promise<AcquireDesktopCliLockOutcome> {
  const pollMs = Math.max(MIN_POLL_MS, pollIntervalMs);
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const attempt = await tryAcquireOnce(path, meta);
    if (attempt !== "held") return { kind: "acquired", handle: attempt };
    const read = await readLockRaw(path);
    if (read.kind === "absent") {
      continue;
    }
    let holder: DesktopCliLockMetadata | null = null;
    let shouldBreak = false;
    if (read.kind === "present") {
      holder = parseLockMetadata(read.raw);
      if (holder !== null) {
        // Only positive evidence permits breaking: the holder's pid is
        // positively dead, or a fresh start-time read positively mismatches
        // the recorded identity (a recycled pid). Indeterminate cases wait
        // regardless of age.
        const identity = verifyProcessIdentity({
          pid: holder.pid,
          startedAtMs: holder.processStartedAtMs,
        });
        shouldBreak = identity === "dead" || identity === "alive-different";
      } else {
        const ageMs = await lockFileAgeMs(path);
        shouldBreak = ageMs !== null && ageMs >= EMPTY_LOCK_GRACE_MS;
      }
    }
    if (shouldBreak && read.kind === "present") {
      const outcome = await breakStaleLock(path, read.raw);
      if (outcome === "broke") continue;
      // "arbitration-busy" / "aborted" / "unlink-failed": fall through to
      // the deadline check + poll sleep.
    }
    if (Date.now() >= deadline) {
      return { kind: "busy", holder };
    }
    await sleep(pollMs);
  }
}

function newAcquisitionMetadata(reason: string): DesktopCliLockMetadata {
  return {
    pid: process.pid,
    reason,
    startedAt: nowIso(),
    hostname: hostnameSafe(),
    token: randomUUID(),
    processStartedAtMs: readProcessStartTimeMs(process.pid),
  };
}

export async function acquireDesktopCliLock(
  opts: AcquireDesktopCliLockOptions,
): Promise<AcquireDesktopCliLockOutcome> {
  return acquireLockAtPath(
    opts.lockPath,
    newAcquisitionMetadata(opts.reason),
    opts.waitMs,
    opts.pollIntervalMs,
  );
}

export type WithDesktopCliLockOutcome<T> =
  | { readonly kind: "acquired"; readonly result: T }
  | { readonly kind: "busy"; readonly holder: DesktopCliLockMetadata | null };

// Acquire, run `fn`, release in `finally` - mirrors the CLI's `withCliLock`.
export async function withDesktopCliLock<T>(
  opts: AcquireDesktopCliLockOptions,
  fn: (handle: DesktopCliLockHandle) => Promise<T>,
): Promise<WithDesktopCliLockOutcome<T>> {
  const outcome = await acquireDesktopCliLock(opts);
  if (outcome.kind === "busy") {
    return { kind: "busy", holder: outcome.holder };
  }
  try {
    const result = await fn(outcome.handle);
    return { kind: "acquired", result };
  } finally {
    await outcome.handle.release();
  }
}
