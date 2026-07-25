import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode } from "./credentials-fs";

/**
 * Cross-process advisory lock for credentials-file mutations (`credentials.lock`
 * beside the credentials file), shared by the desktop main process, the CLI,
 * and the migration path. It exists so that any operation which can spend a
 * single-use refresh token runs strictly serialized: **at most one process ever
 * spends a given refresh token** (credentials-file token-store tech plan, §2).
 * Reads never take the lock.
 *
 * Acquisition is atomic *and* fully-populated: a temp file carrying the whole
 * fingerprint is written first, then hard-`link`ed into place (which fails with
 * EEXIST if the lock already exists). There is never a moment where the lock
 * file exists but is empty or half-written - so any unparseable lock is genuine
 * corruption, handled by an age-based orphan sweep rather than a short
 * open()->write() grace.
 *
 * Takeover happens **only for a provably-dead holder**: the recorded pid is
 * absent, or its queryable OS start-time fingerprint no longer matches (the pid
 * was recycled onto an unrelated process). A live-but-suspended holder, or one
 * whose start time cannot be queried, is never broken - the contender waits
 * (`lock-busy`) and retries. A private nonce alone cannot detect pid reuse,
 * which is why the fingerprint is part of the record.
 */
export interface CredentialsLockHandle {
  readonly path: string;
  readonly nonce: string;
  // Owner-checked unlink: only removes the lock if it still carries this
  // handle's nonce+pid, so a lock re-acquired by someone else after a (false)
  // takeover is never deleted out from under them. Idempotent.
  release(): Promise<void>;
}

export interface AcquireCredentialsLockOptions {
  readonly lockPath: string;
  // What this holder is doing - recorded for observability only.
  readonly reason: string;
  // Max time to wait for a busy lock to free up. 0 -> a single attempt.
  readonly waitMs: number;
  // Poll cadence while waiting (clamped to a sane minimum).
  readonly pollIntervalMs: number;
  // Threaded through the wait so an overall deadline/abort can cut the wait
  // short (migration/rotate budget). `null` when the caller has no signal.
  readonly signal: AbortSignal | null;
}

export type AcquireCredentialsLockResult =
  | { readonly acquired: true; readonly handle: CredentialsLockHandle }
  | { readonly acquired: false };

interface LockContent {
  readonly pid: number;
  readonly pidStartTime: string | null;
  readonly acquisitionNonce: string;
  readonly acquiredAt: number;
  readonly reason: string;
}

const MIN_POLL_MS = 25;

// Release must not leak a live self-owned lock on a transient unlink failure
// (a Windows sharing violation / AV hold); a few bounded retries before giving
// up and leaving it for a later release() to retry.
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 15;

// A parseable lock is only ever created fully-populated (temp+link), so an
// unparseable lock is real corruption or foreign tampering - never our own
// mid-write state. Break it only once it has aged well past any legitimate hold
// (which is bounded by one ~10s in-lock refresh attempt).
const ORPHAN_LOCK_GRACE_MS = 60_000;

/**
 * Acquire the lock, waiting up to `waitMs`. Resolves `{ acquired: false }` on a
 * live/uncertain holder that never frees it in time or on abort - the caller
 * maps that to the `lock-busy` outcome and retries; the access token in hand
 * stays valid meanwhile, so nothing is lost by waiting. Throws only on an
 * unexpected I/O error (e.g. EACCES on the directory), which the store surfaces
 * as "unavailable".
 */
export async function acquireCredentialsLock(
  opts: AcquireCredentialsLockOptions,
): Promise<AcquireCredentialsLockResult> {
  await mkdir(dirname(opts.lockPath), { recursive: true, mode: 0o700 });
  const content: LockContent = {
    pid: process.pid,
    pidStartTime: ownPidStartFingerprint(),
    acquisitionNonce: randomUUID(),
    acquiredAt: Date.now(),
    reason: opts.reason,
  };
  const serialized = JSON.stringify(content, null, 2);
  const pollMs = Math.max(MIN_POLL_MS, opts.pollIntervalMs);
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  while (true) {
    if (aborted(opts.signal)) return { acquired: false };
    if (await tryLink(opts.lockPath, serialized)) {
      return { acquired: true, handle: makeHandle(opts.lockPath, content) };
    }
    // Contended: inspect the current holder and decide whether to break it.
    const holder = await readLock(opts.lockPath);
    if (holder.kind === "gone") {
      // Vanished between our EEXIST and this read - retry immediately.
      continue;
    }
    // Only a clean removal warrants an immediate retry; a contended or failed
    // break falls through to the bounded wait so a lock we cannot remove (e.g. a
    // denied unlink) times out to lock-busy instead of hot-looping past the
    // deadline (which, with `signal: null`, would hang startup).
    if (holder.kind === "parsed") {
      if (holderProvablyDead(holder.content.pid, holder.content.pidStartTime)) {
        if ((await breakStaleLock(opts.lockPath, holder.raw)) === "removed") {
          continue;
        }
      }
    } else {
      const ageMs = await lockFileAgeMs(opts.lockPath);
      if (ageMs === null || ageMs >= ORPHAN_LOCK_GRACE_MS) {
        if ((await breakStaleLock(opts.lockPath, holder.raw)) === "removed") {
          continue;
        }
      }
    }
    if (Date.now() >= deadline) return { acquired: false };
    await sleepAbortable(pollMs, opts.signal);
  }
}

/** Acquire, run `fn`, release in `finally`. `{ acquired: false }` when busy. */
export async function withCredentialsLock<T>(
  opts: AcquireCredentialsLockOptions,
  fn: (handle: CredentialsLockHandle) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const result = await acquireCredentialsLock(opts);
  if (!result.acquired) return { acquired: false };
  try {
    return { acquired: true, value: await fn(result.handle) };
  } finally {
    await result.handle.release();
  }
}

/**
 * Pure takeover decision, separated so it is exhaustively testable without
 * mocking the OS. A holder is provably dead when its pid is gone (`alive:
 * false`), or when its current start-time fingerprint no longer matches the
 * recorded one (pid recycled). When liveness is uncertain - the fingerprint is
 * unqueryable on this platform (`currentFingerprint: null`) or the record
 * predates fingerprints (`recordedFingerprint: null`) - the holder is assumed
 * **live** and never broken.
 */
export function isHolderProvablyDead(args: {
  readonly alive: boolean;
  readonly recordedFingerprint: string | null;
  readonly currentFingerprint: string | null;
}): boolean {
  if (!args.alive) return true;
  if (args.currentFingerprint === null || args.recordedFingerprint === null) {
    return false;
  }
  return args.currentFingerprint !== args.recordedFingerprint;
}

/** OS-probing wrapper over {@link isHolderProvablyDead} for a recorded holder. */
function holderProvablyDead(
  pid: number,
  recordedFingerprint: string | null,
): boolean {
  // Probe liveness first and short-circuit: a gone pid (the common crash
  // takeover) needs no fingerprint query, which on non-Linux POSIX would spawn
  // `ps` for a result the decision ignores.
  if (!isProcessAlive(pid)) return true;
  return isHolderProvablyDead({
    alive: true,
    recordedFingerprint,
    currentFingerprint: queryPidStartFingerprint(pid),
  });
}

async function tryLink(lockPath: string, serialized: string): Promise<boolean> {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    await link(tmp, lockPath);
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

type ReadLockResult =
  | { readonly kind: "gone" }
  | { readonly kind: "unparseable"; readonly raw: string }
  | {
      readonly kind: "parsed";
      readonly raw: string;
      readonly content: LockContent;
    };

async function readLock(lockPath: string): Promise<ReadLockResult> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "gone" };
    throw err;
  }
  const content = parseLockContent(raw);
  return content === null
    ? { kind: "unparseable", raw }
    : { kind: "parsed", raw, content };
}

/**
 * Break a lock we judged stale. Two layers guard against removing a *live* lock
 * that replaced the stale one since we read it:
 *   1. Re-read `lockPath` and bail unless it still holds the exact bytes we
 *      judged stale. This closes the wide window - our liveness probe shells out
 *      to `ps` (several ms) - in which a competitor could break the stale lock
 *      and link its own fresh one in the gap.
 *   2. The removal is an atomic `rename` aside, making the rename the takeover
 *      arbiter: only one contender can move a given lock instance away (the rest
 *      get ENOENT), which closes the compare-then-unlink race where two breakers
 *      each delete the other's freshly-linked lock and end up dual-held.
 *
 * Residual (documented in the disposition spec alongside M3): if the entry is
 * replaced in the far tighter window *between* the re-read and the rename, the
 * rename moves a fresh lock aside and the best-effort `link`-back restore can
 * fail if the slot was re-taken - dropping a live entry. It is bounded exactly
 * like M3 (single-use rotating tokens make the duplicate spend server-rejected
 * and self-healing), not a durable dual-owner.
 *
 * Returns whether the stale lock was actually removed, so the caller can bound
 * its wait on a break that could not complete rather than hot-looping. Exported
 * for deterministic takeover tests.
 */
export async function breakStaleLock(
  lockPath: string,
  staleRaw: string,
): Promise<"removed" | "contended"> {
  // Layer 1: re-read now (newer than the raw the caller inspected before its
  // liveness probe); if the stale entry was already replaced, do not touch it.
  let current: string;
  try {
    current = await readFile(lockPath, "utf8");
  } catch {
    return "contended"; // gone/unreadable - the acquisition loop re-checks
  }
  if (current !== staleRaw) return "contended"; // changed under us - not ours
  const grave = `${lockPath}.dead-${randomUUID()}`;
  try {
    await rename(lockPath, grave);
  } catch {
    // Another contender already moved it (ENOENT), or the removal was denied
    // (EPERM/EACCES/EBUSY - e.g. a Windows sharing violation). Neither throw nor
    // hot-loop: report contended so the caller falls through to the bounded wait
    // and eventually times out to lock-busy.
    return "contended";
  }
  let moved: string | null;
  try {
    moved = await readFile(grave, "utf8");
  } catch {
    moved = null;
  }
  if (moved === null || moved === staleRaw) {
    await rm(grave, { force: true });
    return "removed";
  }
  // Layer 2 residual: the entry changed between the re-read and the rename, so we
  // moved a fresh lock aside. Put it back without clobbering a newer occupant.
  await link(grave, lockPath).catch(() => {});
  await rm(grave, { force: true });
  return "contended";
}

function makeHandle(
  lockPath: string,
  content: LockContent,
): CredentialsLockHandle {
  let released = false;
  return {
    path: lockPath,
    nonce: content.acquisitionNonce,
    release: async () => {
      if (released) return;
      for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
        try {
          const holder = await readLock(lockPath);
          if (
            holder.kind !== "parsed" ||
            holder.content.acquisitionNonce !== content.acquisitionNonce ||
            holder.content.pid !== content.pid
          ) {
            // Gone, or re-acquired by someone else after a (false) takeover -
            // nothing of ours to remove.
            released = true;
            return;
          }
          await unlink(lockPath);
          released = true;
          return;
        } catch (err) {
          if (errorCode(err) === "ENOENT") {
            released = true;
            return;
          }
          // Transient (Windows sharing violation / AV): back off and retry so a
          // live self-owned lock is not leaked for the process lifetime, which
          // would wedge this process's own later mutations against its own pid.
          if (attempt < RELEASE_ATTEMPTS - 1) {
            await sleepAbortable(RELEASE_RETRY_MS, null);
          }
        }
      }
      // Retries exhausted; leave `released` false so a later release() retries.
    },
  };
}

function parseLockContent(raw: string): LockContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  // pid + nonce are the essential fields; a record missing either is treated as
  // corruption (age-based orphan recovery), not a live holder.
  if (typeof obj.pid !== "number" || typeof obj.acquisitionNonce !== "string") {
    return null;
  }
  return {
    pid: obj.pid,
    pidStartTime:
      typeof obj.pidStartTime === "string" ? obj.pidStartTime : null,
    acquisitionNonce: obj.acquisitionNonce,
    acquiredAt: typeof obj.acquiredAt === "number" ? obj.acquiredAt : 0,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

async function lockFileAgeMs(lockPath: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

// Cross-platform process-liveness probe: POSIX `process.kill(pid, 0)` (EPERM =>
// alive, ESRCH => gone); Windows `tasklist`. Mirrors the CLI's shared
// `isProcessAlive` (protocol cannot import upward into the CLI, and this variant
// also feeds the start-time fingerprint below).
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      const stdout = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      );
      const trimmed = stdout.trim();
      if (trimmed.length === 0) return false;
      return trimmed.includes(`"${pid}"`);
    } catch {
      // tasklist missing/refused - treat as held so we never break a lock we
      // cannot probe.
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

let cachedOwnFingerprint: string | null | undefined;

function ownPidStartFingerprint(): string | null {
  if (cachedOwnFingerprint === undefined) {
    cachedOwnFingerprint = queryPidStartFingerprint(process.pid);
  }
  return cachedOwnFingerprint;
}

/**
 * A stable per-process start-time fingerprint, or `null` when it cannot be
 * determined (unsupported platform or query failure). Linux reads
 * `/proc/<pid>/stat`; other POSIX shells out to `ps -o lstart=`. A `null`
 * result means "cannot prove dead" upstream, never "dead". Exported so the
 * timezone-invariance of the fingerprint can be tested directly.
 */
export function queryPidStartFingerprint(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxStartTime(pid);
  if (process.platform === "win32") return null;
  return psLstart(pid);
}

function linuxStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields: `pid (comm) state ppid ... starttime(22) ...`. `comm` may contain
    // spaces and parens, so split from after the LAST ')': the remainder starts
    // at field 3 (state), making starttime (field 22) index 19.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const starttime = fields[19];
    return typeof starttime === "string" && starttime.length > 0
      ? starttime
      : null;
  } catch {
    return null;
  }
}

function psLstart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
      // `lstart` is rendered in the caller's timezone/locale; force a fixed one
      // so the same live PID fingerprints identically across processes. A
      // desktop holder in local time and a `TZ=UTC` CLI contender must not
      // disagree and mistake a live holder for a recycled PID - that would break
      // a live lock and let both spend the same refresh token.
      env: { ...process.env, TZ: "UTC", LC_ALL: "C", LC_TIME: "C" },
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function aborted(signal: AbortSignal | null): boolean {
  return signal !== null && signal.aborted;
}

function sleepAbortable(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (aborted(signal)) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      if (signal !== null) signal.removeEventListener("abort", finish);
      resolve();
    }
    if (signal !== null)
      signal.addEventListener("abort", finish, { once: true });
  });
}
