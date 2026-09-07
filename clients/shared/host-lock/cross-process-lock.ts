import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";
import {
  readProcessStartIdentity,
  readProcessStartTimeMs,
  verifyProcessIdentity,
  type ProcessIdentityVerdict,
} from "./process-identity";

// Cross-process file lock protocol (Host Update Layer Redesign Tech Plan, "cli-lock" rule 3: "Electron main implements the identical lock protocol [as the CLI] (same file, desktop PID + start-time identity)").

export interface LockMetadata {
  readonly pid: number;
  readonly reason: string;
  readonly startedAt: string;
  readonly hostname: string | null;
  // Per-acquisition nonce so `release()` can verify it still owns the file before unlinking (see `tryAcquireOnce`).
  // `null` only for a lock written by a pre-token version - never written by this code.
  readonly token: string | null;
  // The holder process's OS start time (milliseconds since epoch, best-effort) - distinct from `startedAt` above, which is when the *lock* was acquired.
  // Lets a contender positively confirm "still the same process" rather than "some process is alive at this pid" (the OS is free to recycle a pid onto an unrelated process).
  readonly processStartedAtMs: number | null;
  // The holder's kernel creation stamp - the operand arbitration actually compares.
  // `null` for a lock written before this field existed, which `verifyProcessIdentity` reports as "indeterminate" and therefore never breaks.
  readonly processStartIdentity: ProcessStartIdentity | null;
  /**
   * Optional detached posix process group supervised by `pid`.
   * It is deliberately advisory-to-safety: an indeterminate probe is busy, never breakable.
   */
  readonly supervisedProcessGroupId?: number;
  /**
   * A supervisor may be responsible for a Windows process tree whose membership Node cannot positively enumerate.
   * If that supervisor dies before a protocol-confirmed handback, fail closed rather than guessing that taskkill completed.
   */
  readonly retainOnPublisherDeath?: boolean;
}

export interface LockHandle {
  readonly path: string;
  readonly metadata: LockMetadata;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  readonly lockPath: string;
  // What this lock holder is doing - written into the lock file for
  // observability ("install-host", "host-controller-activate", etc.).
  readonly reason: string;
  // Max time to wait for the lock to free up.
  // Defaults are *not* used here per project style; callers must decide.
  readonly waitMs: number;
  // Poll interval while waiting. The runtime clamps below to a sane min.
  readonly pollIntervalMs: number;
}

export type AcquireLockOutcome =
  | { readonly kind: "acquired"; readonly handle: LockHandle }
  | { readonly kind: "busy"; readonly holder: LockMetadata | null };

const MIN_POLL_MS = 25;

// An empty or corrupt lock file means the holder created it with O_EXCL but died before writing its metadata - unless a live holder is still mid-creation and simply hasn't written yet.
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

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function errorCode(err: unknown): string | null {
  if (isErrnoException(err)) {
    return typeof err.code === "string" ? err.code : null;
  }
  return null;
}

// Node-on-Windows exposes neither O_NOFOLLOW nor O_NONBLOCK.
// That is a capability distinction, not evidence that every existing lock is unsafe: use a before/opened/after identity proof there.
interface LockReadPlatform {
  readonly noFollow: number;
  readonly nonBlock: number;
}

const defaultLockReadPlatform: LockReadPlatform = {
  noFollow: typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0,
  nonBlock: typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0,
};

let lockReadPlatformForTest: LockReadPlatform | null = null;

/** Test-only override for the missing-flag Node/Electron fallback. */
export function __setLockReadPlatformForTest(
  platform: LockReadPlatform | null,
): void {
  lockReadPlatformForTest = platform;
}

function lockReadPlatform(): LockReadPlatform {
  return lockReadPlatformForTest ?? defaultLockReadPlatform;
}

// Supported-filesystem policy: this flagless-fallback identity proof only runs where O_NOFOLLOW/O_NONBLOCK are unavailable (Node on Windows).
function samePositiveFileIdentity(
  a: Pick<Stats, "ino" | "dev">,
  b: Pick<Stats, "ino" | "dev">,
): boolean {
  if (a.ino === 0 || a.dev === 0 || b.ino === 0 || b.dev === 0) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

// Result of a raw read of a lock-shaped file.
// `read-error` must be treated as busy/indeterminate everywhere a break decision is made.
type LockRead =
  | { readonly kind: "present"; readonly raw: string }
  | { readonly kind: "absent" }
  | { readonly kind: "read-error" };

  // It must also be total.
// On posix we bind a nonblocking, no-follow descriptor and verify it is regular before reading.
async function readLockRaw(path: string): Promise<LockRead> {
  const platform = lockReadPlatform();
  const hasSafeDescriptorOpen =
    platform.noFollow !== 0 && platform.nonBlock !== 0;
  let before: Stats | null = null;

  if (!hasSafeDescriptorOpen) {
    try {
      const inspected = await lstat(path);
      if (!inspected.isFile()) return { kind: "read-error" };
      before = inspected;
    } catch (err) {
      return errorCode(err) === "ENOENT"
        ? { kind: "absent" }
        : { kind: "read-error" };
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (hasSafeDescriptorOpen
          ? platform.noFollow | platform.nonBlock
          : platform.nonBlock),
    );
  } catch (err) {
    return errorCode(err) === "ENOENT"
      ? { kind: "absent" }
      : { kind: "read-error" };
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: "read-error" };
    if (before !== null) {
      let after: Stats;
      try {
        after = await lstat(path);
      } catch {
        return { kind: "read-error" };
      }
      if (
        !after.isFile() ||
        !samePositiveFileIdentity(before, opened) ||
        !samePositiveFileIdentity(opened, after)
      ) {
        return { kind: "read-error" };
      }
    }
    return { kind: "present", raw: await handle.readFile("utf8") };
  } catch {
    return { kind: "read-error" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseLockMetadata(raw: string): LockMetadata | null {
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
  const metadata: LockMetadata = {
    pid: obj.pid,
    reason: obj.reason,
    startedAt: obj.startedAt,
    hostname: typeof obj.hostname === "string" ? obj.hostname : null,
    token: typeof obj.token === "string" ? obj.token : null,
    processStartedAtMs:
      typeof obj.processStartedAtMs === "number"
        ? obj.processStartedAtMs
        : null,
    processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
      ? obj.processStartIdentity
      : null,
  };
  // No supervised actuator can legitimately lead process group 1 (init's).
  const supervisedProcessGroupId =
    typeof obj.supervisedProcessGroupId === "number" &&
    Number.isSafeInteger(obj.supervisedProcessGroupId) &&
    obj.supervisedProcessGroupId > 1
      ? obj.supervisedProcessGroupId
      : undefined;
  return {
    ...metadata,
    ...(supervisedProcessGroupId === undefined
      ? {}
      : { supervisedProcessGroupId }),
    ...(obj.retainOnPublisherDeath === true
      ? { retainOnPublisherDeath: true }
      : {}),
  };
}

// Age of the lock file in milliseconds, or null if it can no longer be stat'd (already swept by another process).
// Used only to decide whether an empty/corrupt lock file is a crashed holder vs. one mid-creation.
async function lockFileAgeMs(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

// ---- Break-arbitration sub-lock -------------------------------------------- Lock-breaking is serialized through a second, short-lived lock (`<lockPath>.break`) rather than a direct unlink of the canonical lock.

interface BreakLockPayload {
  readonly pid: number;
  readonly startedAt: string;
  // Retained for older readers; arbitration reads `processStartIdentity`.
  // See `LockMetadata` for why.
  readonly processStartedAtMs: number | null;
  readonly processStartIdentity: ProcessStartIdentity | null;
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
    processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
      ? obj.processStartIdentity
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

// Best-effort recovery of a break-lock abandoned by a breaker that crashed mid-critical-section.
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
      startIdentity: payload.processStartIdentity,
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
    processStartIdentity: readProcessStartIdentity(process.pid),
    token,
  };
  if ((await createBreakLockFile(breakLockPath, payload)) === "created") {
    return { kind: "acquired", token };
  }
  // Eexist - another breaker may be genuinely active, or may have crashed mid-critical-section.
  // Attempt recovery once; if that doesn't free the path, this contender simply falls back to the normal deadline/poll path rather than spinning on arbitration.
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
  // The canonical lock was confirmed still stale (under arbitration) and
  // unlinked. Safe to retry acquisition immediately.
  | "broke"
  // Another contender is already breaking this lock (or recovering a
  // crashed breaker). Not our job to act further this iteration.
  | "arbitration-busy"
  // Nothing to restore either way; must not treat this as a break.
  | "aborted"
  // We won the break-lock and confirmed the content was still stale, but
  // the unlink itself failed (e.g. a transient filesystem error).
  | "unlink-failed";

async function breakStaleLock(
  path: string,
  decisionRaw: string,
): Promise<BreakStaleLockOutcome> {
  const acquired = await acquireBreakLock(path);
  if (acquired.kind === "busy") return "arbitration-busy";
  try {
    // A read error here is never evidence (the same rule as the outer break decision) - abort rather than risk unlinking a file we can't actually verify.
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

// ---- Test-only break-decision pause/observability seam --------------------- Gated on an env var, unset in production (a single lookup, near-zero cost).
// Never read or written by production code paths.
const BREAK_HOOK_DIR_ENV = "TRAYCER_CLI_LOCK_TEST_BREAK_HOOK_DIR";
const BREAK_HOOK_POLL_MS = 20;
const BREAK_HOOK_MAX_WAIT_MS = 15_000;

async function pauseBeforeBreakForTest(): Promise<void> {
  const dir = process.env[BREAK_HOOK_DIR_ENV];
  if (dir === undefined) return;
  await writeFile(join(dir, "ready"), "").catch(() => undefined);
  const deadline = Date.now() + BREAK_HOOK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const exists = await stat(join(dir, "go"))
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await sleep(BREAK_HOOK_POLL_MS);
  }
}

async function recordBreakOutcomeForTest(
  outcome: BreakStaleLockOutcome,
): Promise<void> {
  const dir = process.env[BREAK_HOOK_DIR_ENV];
  if (dir === undefined) return;
  await writeFile(join(dir, "outcome"), outcome).catch(() => undefined);
}

// The arms mirror `LockRead`'s only-positive-evidence discipline exactly: `absent` is the only arm that proves nobody holds the lock.
export type LockHolderProbe =
  | { readonly kind: "absent" }
  | { readonly kind: "held"; readonly holder: LockMetadata }
  | { readonly kind: "unparseable" }
  | { readonly kind: "read-error" };

export async function readLockHolder(path: string): Promise<LockHolderProbe> {
  const read = await readLockRaw(path);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "read-error") return { kind: "read-error" };
  const holder = parseLockMetadata(read.raw);
  return holder === null ? { kind: "unparseable" } : { kind: "held", holder };
}

/**
 * Rewrite liveness metadata only while the canonical lock still carries the expected token.
 * This shares the stale-break arbitration lock: a contender that observed a dead publisher cannot unlink/acquire between our ownership check and the rewrite, and we never restore an old token over a new holder.
 */
export async function rewriteLockLivenessIfToken(
  path: string,
  expectedToken: string,
  next: LockMetadata,
): Promise<boolean> {
  const arbitration = await acquireBreakLock(path);
  if (arbitration.kind === "busy") return false;
  try {
    const read = await readLockRaw(path);
    if (read.kind !== "present") return false;
    const current = parseLockMetadata(read.raw);
    if (current === null || current.token !== expectedToken) return false;
    // Keep the acquisition identity immutable. A liveness rebind must never
    // become an accidental authority transfer to a different lock token.
    if (
      next.token !== expectedToken ||
      next.reason !== current.reason ||
      next.startedAt !== current.startedAt
    ) {
      return false;
    }
    // A crashed publisher must never leave a truncated canonical lock that a later contender can age-break while its supervised actuator still runs.
    // The arbitration lock serializes us with stale breaking; a same-directory temp + rename makes publication itself atomic to every reader.
    const temporaryPath = `${path}.${randomUUID()}.liveness`;
    try {
      const temporary = await open(temporaryPath, "wx", 0o600);
      try {
        await temporary.writeFile(JSON.stringify(next, null, 2), "utf8");
        await temporary.sync();
      } finally {
        await temporary.close().catch(() => undefined);
      }
      await rename(temporaryPath, path);
      // The temp fsync above makes the content durable; the directory entry the rename swapped is separate metadata with its own flush.
      // Best-effort where directories cannot be opened (win32): rename durability there is bounded by the platform, and a failed dir sync must not turn a completed rename into a refusal.
      try {
        const dir = await open(dirname(path), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close().catch(() => undefined);
        }
      } catch {
        // Windows cannot open directories; elsewhere a failed dir sync
        // leaves durability at the platform's rename guarantee.
      }
    } catch {
      // A failed republication is a refusal, not an exception: every other denial in this function returns false, and callers treat a rebind as deniable rather than wrapping it in try/catch.
      return false;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return true;
  } finally {
    await releaseBreakLock(path, arbitration.token);
  }
}

/**
 * Conservative holder liveness used by both acquisition and read-side projections.
 * On platforms where Node cannot prove the group gone, `retainOnPublisherDeath` fails closed rather than guessing.
 */
export function verifyLockHolderLiveness(
  holder: LockMetadata,
): ProcessIdentityVerdict {
  const publisher = verifyProcessIdentity({
    pid: holder.pid,
    startedAtMs: holder.processStartedAtMs,
    startIdentity: holder.processStartIdentity,
  });
  if (publisher === "alive-same" || publisher === "indeterminate") {
    return publisher;
  }
  if (holder.supervisedProcessGroupId !== undefined) {
    const group = probeProcessGroupLiveness(holder.supervisedProcessGroupId);
    if (group === "alive") return "alive-same";
    if (group === "indeterminate") return "indeterminate";
    return publisher;
  }
  return holder.retainOnPublisherDeath === true ? "indeterminate" : publisher;
}

function probeProcessGroupLiveness(
  processGroupId: number,
): "alive" | "dead" | "indeterminate" {
  if (process.platform === "win32") return "indeterminate";
  // Parse already refuses group ids ≤ 1, but this probe is the last line: `process.kill(-1, 0)` asks "can I signal any process", which is true on every running machine and would report an eternal holder.
  if (processGroupId <= 1) return "indeterminate";
  try {
    // A negative PID probes the POSIX process group. Its leader may already
    // have exited while a platform child continues the irreversible edge.
    process.kill(-processGroupId, 0);
    return "alive";
  } catch (err) {
    const code = errorCode(err);
    if (code === "EPERM") return "alive";
    if (code === "ESRCH") return "dead";
    return "indeterminate";
  }
}

async function tryAcquireOnce(
  path: string,
  meta: LockMetadata,
): Promise<LockHandle | "held"> {
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
      // Compare-and-delete: unlink only on positive proof this handle still owns the file - a successful, parseable read whose token matches the one this handle wrote.
      // This is a raw read, not a read+fold-to-null shortcut: a transient read error (eio/eacces) must never be treated the same as "absent" here either.
      const read = await readLockRaw(path);
      if (read.kind === "read-error") {
        return;
      }
      if (read.kind === "absent") {
        // Already gone - released normally already, or broken by another
        // contender. Nothing to unlink.
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
      // A parent handle can publish a supervised child only for liveness; it must nevertheless never unlink that child's record on an error path.
      // If the child died and its group/tree is not positively gone, retaining the lock is the fail-closed outcome.
      if (
        current.pid !== meta.pid &&
        (current.supervisedProcessGroupId !== undefined ||
          current.retainOnPublisherDeath === true)
      ) {
        return;
      }
      try {
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

async function acquireLockAtPath(
  path: string,
  meta: LockMetadata,
  waitMs: number,
  pollIntervalMs: number,
): Promise<AcquireLockOutcome> {
  const pollMs = Math.max(MIN_POLL_MS, pollIntervalMs);
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const attempt = await tryAcquireOnce(path, meta);
    if (attempt !== "held") return { kind: "acquired", handle: attempt };
    const read = await readLockRaw(path);
    if (read.kind === "absent") {
      // Whatever was here a moment ago is already gone (released normally, or broken by another contender) - retry acquisition immediately rather than falling through to a break decision with nothing to break.
      continue;
    }
    let holder: LockMetadata | null = null;
    let shouldBreak = false;
    if (read.kind === "present") {
      holder = parseLockMetadata(read.raw);
      if (holder !== null) {
        // Only positive evidence permits breaking a lock with a parsed holder record: the holder's pid is positively dead, or a fresh start-time read positively mismatches the recorded identity (a recycled pid).
        // There is deliberately no age ceiling here - a genuinely alive, genuinely identity-verified holder is never broken out from under itself no matter how long its operation takes.
        const identity = verifyLockHolderLiveness(holder);
        shouldBreak = identity === "dead" || identity === "alive-different";
      } else {
        // Empty or corrupt lock file - no PID to probe.
        // A crashed holder that died between open() and writeFile() leaves exactly this, and it can never self-recover via the PID path above.
        const ageMs = await lockFileAgeMs(path);
        shouldBreak = ageMs !== null && ageMs >= EMPTY_LOCK_GRACE_MS;
      }
    }
    if (shouldBreak && read.kind === "present") {
      // Test-only no-op in production (see `pauseBeforeBreakForTest`'s
      // doc comment).
      await pauseBeforeBreakForTest();
      const outcome = await breakStaleLock(path, read.raw);
      await recordBreakOutcomeForTest(outcome);
      if (outcome === "broke") continue;
    }
    if (Date.now() >= deadline) {
      return { kind: "busy", holder };
    }
    await sleep(pollMs);
  }
}

function newAcquisitionMetadata(reason: string): LockMetadata {
  return {
    pid: process.pid,
    reason,
    startedAt: nowIso(),
    hostname: hostnameSafe(),
    token: randomUUID(),
    processStartedAtMs: readProcessStartTimeMs(process.pid),
    processStartIdentity: readProcessStartIdentity(process.pid),
  };
}

export async function acquireLock(
  opts: AcquireLockOptions,
): Promise<AcquireLockOutcome> {
  return acquireLockAtPath(
    opts.lockPath,
    newAcquisitionMetadata(opts.reason),
    opts.waitMs,
    opts.pollIntervalMs,
  );
}

export type WithLockOutcome<T> =
  | { readonly kind: "acquired"; readonly result: T }
  | { readonly kind: "busy"; readonly holder: LockMetadata | null };

  // Acquire, run `fn`, release in `finally`. Catches nothing on the inner
// function; the lock is released either way.
export async function withLock<T>(
  opts: AcquireLockOptions,
  fn: (handle: LockHandle) => Promise<T>,
): Promise<WithLockOutcome<T>> {
  const outcome = await acquireLock(opts);
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
