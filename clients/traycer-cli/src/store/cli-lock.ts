import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
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

// Mirrors `EMPTY_LOCK_GRACE_MS` for the break-arbitration sub-lock itself
// (see `acquireBreakLock`/`tryRecoverCrashedBreakLock` below): its own
// metadata write lands within milliseconds of its `open()`, so a break-lock
// file younger than this grace window might just be a breaker still
// mid-creation, not a crashed one.
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

function errorCode(err: unknown): string | null {
  if (isErrnoException(err)) {
    return typeof err.code === "string" ? err.code : null;
  }
  return null;
}

// Result of a raw read of a lock-shaped file. Distinguishes "genuinely not
// there" (`absent`, ENOENT) from "we don't know" (`read-error` - a
// transient EIO/EACCES/etc.) from "successfully read N bytes" (`present`,
// which may still fail to *parse* as valid metadata - that's a successful
// read of empty/corrupt content, not a read failure).
//
// This distinction matters because only `present` can ever contribute
// positive evidence toward breaking a lock: a prior version of this module
// collapsed every read failure to the same `null` a genuinely-absent file
// produced, which fed straight into the empty/corrupt age-based break AND
// the stale-claim equality check - a transient read error could earn the
// same "safe to break" treatment as a holder that actually crashed
// mid-write. `read-error` must be treated as busy/indeterminate everywhere
// a break decision is made.
type LockRead =
  | { readonly kind: "present"; readonly raw: string }
  | { readonly kind: "absent" }
  | { readonly kind: "read-error" };

// Split out from `parseLockMetadata` below so the poll loop can capture the
// EXACT bytes a break decision was based on and later hand them to
// `breakStaleLock` for its arbitrated equality check - re-reading at break
// time would defeat the point, since the whole race this guards against is
// content changing between read and break.
async function readLockRaw(path: string): Promise<LockRead> {
  try {
    return { kind: "present", raw: await readFile(path, "utf8") };
  } catch (err) {
    return errorCode(err) === "ENOENT"
      ? { kind: "absent" }
      : { kind: "read-error" };
  }
}

function parseLockMetadata(raw: string): CliLockMetadata | null {
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

// ---- Break-arbitration sub-lock ------------------------------------------
//
// Lock-breaking is serialized through a second, short-lived lock
// (`<lockPath>.break`) rather than a direct unlink of the canonical lock.
// An earlier version of this module used a rename-to-claim protocol
// instead (atomically rename the canonical lock aside, then verify its
// content before deleting it) - that is unsound: a bare `rename` cannot be
// made CONDITIONAL on the destination's content, so a contender delayed
// just long enough after its own stale read could rename away a lock a
// different, genuinely fresh holder had since written, and the
// content-mismatch "restore" path could then clobber a THIRD holder that
// had meanwhile written to the now-vacated path. Simultaneous holders
// remained possible.
//
// Serializing the unlink itself behind an exclusively-held second lock
// closes this: while the break-lock is held, no other contender can
// unlink the canonical file, and a fresh holder can only ever appear
// AFTER an unlink completes - so a raw-byte equality check taken under the
// break-lock is conclusive proof the file is still the exact stale
// content the break decision was made on. Empty/corrupt-lock breaking goes
// through the identical arbitration - it has the identical unlink race.

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

// Best-effort recovery of a break-lock abandoned by a breaker that crashed
// mid-critical-section. Uses the same only-positive-evidence identity
// rules as the canonical lock, plus `BREAK_LOCK_AGE_GRACE_MS` so a breaker
// that has only just called `open()` (file exists, payload not written
// yet) is never mistaken for a crash. Returns whether the break-lock was
// removed (safe for the caller to retry creating it).
//
// Accepted residual: the `unlink(breakLockPath)` call below is
// UNCONDITIONAL - it verifies the crashed holder's identity and age from
// the read a few lines up, but never re-verifies the file still holds
// those exact bytes immediately before deleting it by path. TWO
// recoverers already suffice to exploit this (no third contender or
// completed unrelated cycle required):
//   - R1 and R2 both see the same crashed break-lock B0 and both validate
//     it (dead pid, aged past the grace window) - both are now AUTHORIZED
//     to unlink whatever they find at this path, per the checks above.
//   - R1 acts on its authorization first: unlinks B0, then wins the
//     O_CREAT|O_EXCL retry and creates its own break-lock B1. R1 is now
//     genuinely, exclusively holding the break-lock and enters its
//     `breakStaleLock` critical section.
//   - R2 was descheduled between ITS OWN read/validate (above) and ITS
//     OWN unlink call - a real gap between two syscalls, with NO time
//     bound, not the "millisecond-wide" window this comment previously
//     (incorrectly) claimed. When R2 finally resumes, its unlink targets
//     a PATH, not a file identity, and fires unconditionally on its
//     stale authorization: it deletes whatever is CURRENTLY there - B1,
//     R1's live break-lock - out from under R1. R2 then wins its own
//     O_CREAT|O_EXCL retry and creates B2.
// R1 (still mid-critical-section, unaware B1 was ever touched) and R2
// (now also mid-critical-section on B2) both believe they exclusively
// hold the break-lock and can run their own `breakStaleLock` critical
// sections concurrently: this CAN violate canonical-lock exclusion,
// contrary to what this comment used to claim. (A three-or-more-contender
// variant - an entire extra break-then-reacquire cycle completing inside
// the gap - is also possible, but is not the minimum.) It is accepted
// because it requires a breaker crash AND a second contender's own
// recovery attempt to be descheduled between its validation and its
// unlink at essentially the exact moment a first recoverer completes its
// own unlink-then-create step underneath it - vastly narrower than the
// race this whole mechanism replaces (rename-to-claim's routinely-hit,
// unbounded TOCTOU window).
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
  // EEXIST - another breaker may be genuinely active, or may have crashed
  // mid-critical-section. Attempt recovery once; if that doesn't free the
  // path, this contender simply falls back to the normal deadline/poll
  // path rather than spinning on arbitration.
  if (!(await tryRecoverCrashedBreakLock(breakLockPath))) {
    return { kind: "busy" };
  }
  const retry = await createBreakLockFile(breakLockPath, payload);
  return retry === "created" ? { kind: "acquired", token } : { kind: "busy" };
}

// Compare-and-delete release, mirroring the canonical lock's own
// `release()` - only unlink the break-lock if it still carries the token
// we wrote, so a recovery agent that (correctly) stole this break-lock out
// from under a presumed-crashed breaker never has its ownership silently
// clobbered by that breaker's own, now-late release.
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
  // We won the break-lock, but the canonical lock's content no longer
  // matches the stale bytes the break decision was based on (a fresh
  // holder wrote in the meantime) - or the canonical lock is simply gone
  // already (released normally, or broken by a contender that raced us to
  // the decision but not the arbitration). Nothing to restore either way;
  // must not treat this as a break.
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
    // A read error here is never evidence (the same rule as the outer
    // break decision) - abort rather than risk unlinking a file we can't
    // actually verify.
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

// ---- Test-only break-decision pause/observability seam -------------------
//
// Gated on an env var, unset in production (a single lookup, near-zero
// cost). Lets the genuine multiprocess break-arbitration regression test
// deterministically interleave "this contender decided to break a stale
// lock, but hasn't yet attempted it" with actions taken by a DIFFERENT OS
// process, and records the eventual outcome so the test can assert the
// arbitrated "aborted" path was actually exercised rather than inferring it
// from timing. Never read or written by production code paths.
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
      // Compare-and-delete: unlink ONLY on positive proof this handle
      // still owns the file - a successful, parseable read whose token
      // matches the one this handle wrote. Every lock this code writes
      // carries a non-null `randomUUID()` token, so tokenless or
      // unparseable present content (empty/corrupt bytes, or a fresh
      // holder still mid-`writeFile()`) is by definition not ours - the
      // old fallback of unlinking whenever there was "nothing to compare
      // against" got this backwards: an inability to prove ownership must
      // refuse to delete, not default to deleting.
      //
      // This is a raw read, not a read+fold-to-null shortcut: a transient
      // read ERROR (EIO/EACCES) must never be treated the same as
      // "absent" here either. Release sits downstream of the accepted
      // break-arbitration residual documented above
      // `tryRecoverCrashedBreakLock` - if a crashed breaker was double-
      // recovered, this handle's canonical path may now belong to a fresh
      // holder B. Folding a read error into "nothing to compare, unlink
      // anyway" would let this release blow away B's live lock on nothing
      // but a flaky read - the exact only-positive-evidence rule this
      // module applies to every break decision must hold here too.
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

// Core acquisition loop, factored out of `acquireCliLock` so the genuine
// multiprocess break-arbitration regression test can drive it against an
// arbitrary tmp-dir path via `__acquireCliLockAtPathForTest` below, without
// touching the real `~/.traycer` tree - there is no environment-variable
// override for the CLI home directory, and (notably on this codebase's
// past experience) Bun's `homedir()` does not honor a spawned child
// process's overridden `$HOME`.
async function acquireLockAtPath(
  path: string,
  meta: CliLockMetadata,
  waitMs: number,
  pollIntervalMs: number,
): Promise<CliLockHandle> {
  const pollMs = Math.max(MIN_POLL_MS, pollIntervalMs);
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const attempt = await tryAcquireOnce(path, meta);
    if (attempt !== "held") return attempt;
    const read = await readLockRaw(path);
    if (read.kind === "absent") {
      // Whatever was here a moment ago is already gone (released
      // normally, or broken by another contender) - retry acquisition
      // immediately rather than falling through to a break decision with
      // nothing to break.
      continue;
    }
    let holder: CliLockMetadata | null = null;
    let shouldBreak = false;
    if (read.kind === "present") {
      holder = parseLockMetadata(read.raw);
      if (holder !== null) {
        // Only positive evidence permits breaking a lock with a parsed
        // holder record: the holder's pid is positively dead, or a fresh
        // start-time read positively mismatches the recorded identity (a
        // recycled pid). Indeterminate cases - a liveness-probe failure,
        // or a legacy lock with no recorded process-start-time - wait
        // regardless of age; a wedge is strictly safer than concurrent
        // mutation of the install/staged tree. There is deliberately no
        // age ceiling here any more (see the Host Update Layer Redesign
        // Tech Plan's "cli-lock" section) - a genuinely alive, genuinely
        // identity-verified holder is never broken out from under itself
        // no matter how long its operation takes.
        const identity = verifyProcessIdentity({
          pid: holder.pid,
          startedAtMs: holder.processStartedAtMs,
        });
        shouldBreak = identity === "dead" || identity === "alive-different";
      } else {
        // Empty or corrupt lock file - no PID to probe. A crashed holder
        // that died between open() and writeFile() leaves exactly this,
        // and it can never self-recover via the PID path above. Break it
        // once it has aged past the grace window, so we don't steal a
        // lock from a live holder still in the open()->writeFile() gap.
        // `ageMs === null` (the file vanished between our read and this
        // stat) is NOT positive evidence of anything - only a successful,
        // aged-out stat counts.
        const ageMs = await lockFileAgeMs(path);
        shouldBreak = ageMs !== null && ageMs >= EMPTY_LOCK_GRACE_MS;
      }
    }
    // `read.kind === "read-error"` falls through with `shouldBreak` still
    // false - a read failure is never evidence, so this iteration behaves
    // exactly like any other indeterminate case: no break attempt, just
    // the deadline check + poll sleep below.
    if (shouldBreak && read.kind === "present") {
      // Test-only no-op in production (see `pauseBeforeBreakForTest`'s
      // doc comment).
      await pauseBeforeBreakForTest();
      // `read.raw` is the exact bytes the break decision above was based
      // on - `breakStaleLock` re-verifies (under its own arbitration lock)
      // that the canonical lock still matches this before unlinking it,
      // closing the race where a delayed contender could otherwise unlink
      // a fresh, live holder that appeared between our read and our
      // break.
      const outcome = await breakStaleLock(path, read.raw);
      await recordBreakOutcomeForTest(outcome);
      if (outcome === "broke") continue;
      // "arbitration-busy" (another contender is already breaking this
      // lock), "aborted" (what we read wasn't - or is no longer - the
      // stale holder we decided to break), or "unlink-failed": either way
      // the break failed - fall through to the normal deadline check +
      // poll sleep rather than spinning; the busy-wait contract must hold
      // even when a break attempt doesn't pan out.
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

function newAcquisitionMetadata(reason: string): CliLockMetadata {
  return {
    pid: process.pid,
    reason,
    startedAt: nowIso(),
    hostname: hostnameSafe(),
    token: randomUUID(),
    processStartedAtMs: readProcessStartTimeMs(process.pid),
  };
}

export async function acquireCliLock(
  opts: AcquireCliLockOptions,
): Promise<CliLockHandle> {
  await ensureCliInstallHomeDir(opts.environment);
  const path = cliLockPath(opts.environment);
  return acquireLockAtPath(
    path,
    newAcquisitionMetadata(opts.reason),
    opts.waitMs,
    opts.pollIntervalMs,
  );
}

export interface AcquireCliLockAtPathTestOptions {
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

// Test-only entry point that contends for a lock at an ARBITRARY path,
// bypassing `cliLockPath`'s real `~/.traycer` resolution entirely - see
// `acquireLockAtPath`'s doc comment. The caller is responsible for
// ensuring the parent directory already exists (a real `acquireCliLock`
// call does this via `ensureCliInstallHomeDir`; a test sandbox typically
// already has one from `mkdtemp`). Production code never calls this.
export async function __acquireCliLockAtPathForTest(
  path: string,
  opts: AcquireCliLockAtPathTestOptions,
): Promise<CliLockHandle> {
  return acquireLockAtPath(
    path,
    newAcquisitionMetadata(opts.reason),
    opts.waitMs,
    opts.pollIntervalMs,
  );
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
