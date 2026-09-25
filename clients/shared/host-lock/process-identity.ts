import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import {
  buildWindowsDeniedReadFallbackScript,
  compareObservedProcessStart,
  compareProcessStartIdentity,
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
  formatWindowsProcessStartIdentity,
  parseWindowsDeniedReadFallbackOutput,
  windowsProcessStartIdentityMicros,
  type ObservedProcessStart,
  type ProcessStartIdentity,
  type ProcessStartIdentityMatch,
} from "@traycer/protocol/host/lifecycle";

// Cross-platform process liveness + identity probing. Shared by the CLI's
// `cli-lock` hardening (holder identity - Host Update Layer Redesign Tech
// Plan, "cli-lock - hardening and the mixed-version boundary") and the
// desktop-held lock sections around packaged-macOS SMAppService work (Tech
// Plan, "cli-lock" rule 3: "Electron main implements the identical lock
// protocol"). Both processes need the same answer to "is the process that
// wrote this token still the SAME process, not just the same recycled pid" -
// implemented once here so the two never drift.

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

// ---- Liveness -------------------------------------------------------------

// Tri-state result of a single liveness probe. Distinct from a plain
// boolean so a probe FAILURE (permission denied on an unrelated errno,
// `tasklist` missing/refused, a timeout) is never conflated with either
// "alive" or "dead" - a probe failure must never itself become break
// evidence (Tech Plan's "only positive evidence" rule). Only `"alive"`
// and `"dead"` are positive evidence; `"indeterminate"` means the probe
// established neither.
export type ProcessLivenessVerdict = "alive" | "dead" | "indeterminate";

// Cross-platform process-liveness probe. POSIX uses `process.kill(pid, 0)`;
// Windows uses `tasklist /FI "PID eq <pid>" /NH /FO CSV` and asserts the
// CSV body is non-empty. Exported for the one reader that needs the
// tri-state itself outside this module (`host update`'s progress-marker
// takeover keeps a displaced record for restore only on POSITIVE evidence
// its writer is alive); `verifyProcessIdentity` below consumes it too, and
// everything else goes through the collapsing `isProcessAlive`.
export function probeProcessLiveness(pid: number): ProcessLivenessVerdict {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (process.platform === "win32") {
    let stdout: string;
    try {
      stdout = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        // execFileSync copies a failing child's stderr into this process's
        // stderr unless `stdio` is given; captured here, never forwarded.
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      // tasklist missing or refused - the probe itself failed, so we
      // learned nothing positive either way.
      return "indeterminate";
    }
    // tasklist prints an `INFO: No tasks are running which match...`
    // line on stderr when nothing matches; stdout is empty. When a
    // match exists, stdout contains a CSV row with the binary name
    // and the same PID we asked about.
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return "dead";
    return trimmed.includes(`"${pid}"`) ? "alive" : "dead";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = isErrnoException(err) ? err.code : null;
    // EPERM: the pid positively exists (the kernel found it to check
    // permissions against) - we just can't signal it. Positive evidence
    // of life, not a probe failure.
    if (code === "EPERM") return "alive";
    // ESRCH: the kernel positively has no process at this pid.
    if (code === "ESRCH") return "dead";
    // Any other errno (EIO, an unexpected platform error, ...) is a
    // probe failure, not evidence the process is dead - collapsing it
    // to "dead" (the pre-hardening behavior) let a transient probe
    // glitch break a live holder's lock.
    return "indeterminate";
  }
}

/**
 * Does `pid` name a running process, answered WITHOUT spawning anything?
 *
 * `process.kill(pid, 0)` everywhere: on Windows libuv opens the process and
 * reads its exit code, so it answers without the `tasklist` spawn
 * `probeProcessLiveness` pays there. Measured on the Windows VM
 * (LIVENESS-WIN, ×20 per case at the desktop's own Medium integrity): a live
 * pid succeeds and an exited or reaped one throws ESRCH in about 0.005 ms,
 * flat under a load that timed `tasklist` out on every call.
 *
 * - `exists` - the call succeeded, or on POSIX threw EPERM (the kernel found
 *   the pid to check permissions against).
 * - `gone` - ESRCH: no process at this pid.
 * - `unknown` - anything else, including EPERM on Windows. libuv opens the
 *   process BEFORE it reads the exit code, so there EPERM only says an
 *   object exists that this token cannot open - and a higher-integrity (or
 *   another user's) process that has EXITED while some handle still holds
 *   it answers exactly that (measured: tasklist said dead). Not evidence of
 *   life; a caller that needs one takes the full probe.
 *
 * Existence, not identity: a pid the OS has handed to another process reads
 * `exists`. So `exists` may only KEEP an identity answer a full probe already
 * gave (the desktop's cached verdict), never stand in for one; `gone` and
 * `unknown` both send the caller back to the full probe.
 */
export type SpawnFreeProcessExistence = "exists" | "gone" | "unknown";

export function probeProcessExistenceWithoutSpawn(
  pid: number,
): SpawnFreeProcessExistence {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (err) {
    const code = isErrnoException(err) ? err.code : null;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM" && process.platform !== "win32") return "exists";
    return "unknown";
  }
}

// Public boolean liveness check for legacy callers (`host/busy-check.ts`,
// service controllers, doctor) that only need "is *something* running
// here" with no identity-verdict fallback to route a probe failure to.
// Conservatively collapses "indeterminate" to `true` (never tell a
// legacy caller a possibly-live process is dead) - `verifyProcessIdentity`
// below does NOT go through this collapse; it consumes
// `probeProcessLiveness`'s tri-state result directly so a probe failure
// can never masquerade as break evidence.
export function isProcessAlive(pid: number): boolean {
  return probeProcessLiveness(pid) !== "dead";
}

// Read a live process's OS start time without applying identity-token
// equality semantics. Consumers that compare this value with a timestamp
// published by a different system (for example pid.json readiness metadata)
// need an ordering check, not `verifyProcessIdentity`'s same-process
// tolerance. A failed liveness or start-time probe remains inconclusive.
//
// A verifying read, so a Windows read that was DENIED falls back to WMI's
// creation time (see `observeProcessStart`). Floored to milliseconds that is
// byte-identical to what the exact read's `Date.parse` gives: both truncate
// the same kernel FILETIME - WMI to the microsecond (measured), `Date.parse`
// the round-trip string's seven fractional digits to three - and that
// agreement is what makes this path tolerance-free: the value is the one the
// exact read would have produced.
export function readLiveProcessStartTimeMs(pid: number): number | null {
  if (probeProcessLiveness(pid) !== "alive") return null;
  const startedAtMs = processStartTimeReader(pid);
  if (startedAtMs !== null) return startedAtMs;
  const creationMicros = windowsDeniedReadCreationReader(pid);
  return creationMicros === null ? null : Math.floor(creationMicros / 1000);
}

export type PublishedProcessIdentityVerdict =
  | "current"
  | "mismatch"
  | "dead"
  | "indeterminate";

/**
 * Electron-main checks an advertised endpoint first. Once the handshake has
 * established positive liveness, identity only rules out a positively
 * demonstrated recycled-PID impostor; a failed OS probe is deliberately
 * inconclusive rather than evidence the healthy endpoint is down.
 *
 * `publishedStartIdentity` is `pid.json`'s `processStartIdentity` - the
 * kernel's own record of when the publishing process was created (see
 * `@traycer/protocol/host/lifecycle`'s `process-start-identity`). It is
 * compared byte-for-byte against the same value read now.
 *
 * ### What this used to do, and why it had to stop
 *
 * The previous test was a *causality* one: derive the process's start time as
 * `Date.now() - <elapsed since start>` and call it a recycled pid if that
 * landed more than 1.25s after `pid.json`'s publication timestamp. The
 * derivation reads the elapsed term from the boot clock and the anchor from
 * the realtime clock, so a `CLOCK_REALTIME` step between publication and this
 * read shifts the result by the whole step. Past 1.25s of shift the verdict
 * became `"mismatch"` - permanently, since every later read re-derived the
 * same shifted value - for a completely healthy process.
 *
 * traycerai/traycer#740 is what that costs. On WSL2, whose realtime clock is
 * resynchronised when the VM resumes from an idle pause, one such verdict
 * both told `isPublishedHostEndpointReachable` that a host answering in 8ms
 * was unreachable AND told the recovery governor's liveness gate that a
 * running process was dead - manufacturing an outage and disabling the guard
 * against acting on it, in a single value. The user's session was torn down
 * every few minutes until the respawn budget ran out and the app wedged on
 * "Traycer Host became unavailable".
 *
 * So there is no wall-clock fallback here on purpose. When the clock-immune
 * comparison cannot be made - a `pid.json` written by a host that predates
 * the field, or a platform probe that failed - the honest answer is
 * `"indeterminate"`, and every caller already routes that to its fail-open
 * branch. Losing recycled-pid detection for those records is a real cost, but
 * it is bounded (the user is asked to click Retry) where the false positive
 * is not (a healthy host is killed on a loop). New hosts publish the field
 * and get exact detection back.
 */
export async function getPublishedProcessIdentityVerdict(
  pid: number,
  publishedStartIdentity: ProcessStartIdentity | null,
): Promise<PublishedProcessIdentityVerdict> {
  const liveness = await asyncProcessLivenessReader(pid);
  if (liveness === "dead") return "dead";
  if (liveness !== "alive") return "indeterminate";
  // Nothing was recorded to compare against, so probing the live process
  // cannot change the answer - `compareProcessStartIdentity` would return
  // "unknown" whatever comes back. Skipping it matters: this predicate runs on
  // every health tick, and every pid.json in the field today predates the
  // field, so the probe would be a subprocess spawn per tick, forever, for a
  // result that is discarded.
  if (publishedStartIdentity === null) return "indeterminate";
  const observed = await observeProcessStartAsync(pid, publishedStartIdentity);
  switch (compareObservedProcessStart(publishedStartIdentity, observed)) {
    case "same":
      return "current";
    case "different":
      return "mismatch";
    case "unknown":
      return "indeterminate";
  }
}

// ---- Identity (pid + process creation stamp) -------------------------------

export interface ProcessIdentityToken {
  readonly pid: number;
  /**
   * Milliseconds since epoch, best-effort.
   *
   * NO LONGER READ by any verdict in this module - `startIdentity` replaced
   * it, for the reasons in `computeProcessIdentityVerdict`. It is still
   * WRITTEN so that a token produced by this version stays fully usable by an
   * older process reading the same on-disk lock: dropping it would make older
   * readers see a legacy token, answer "indeterminate", and refuse to break a
   * genuinely stale lock - trading a rare wrong break for a permanent wedge.
   * Delete it only once no supported version reads it.
   */
  readonly startedAtMs: number | null;
  /**
   * The kernel's creation stamp for this process - the operand every verdict
   * below actually compares. `null` when the platform probe failed, or when
   * the token was written before this field existed; both mean "cannot
   * compare", never "different process".
   */
  readonly startIdentity: ProcessStartIdentity | null;
}

export function currentProcessIdentityToken(): ProcessIdentityToken {
  return {
    pid: process.pid,
    startedAtMs: readProcessStartTimeMs(process.pid),
    startIdentity: readProcessStartIdentity(process.pid),
  };
}

const POSIX_ELAPSED_UPTIME_SLACK_SECONDS = 1;
const POSIX_PROCESS_START_TIME_MAX_RETRIES = 3;

export type ProcessIdentityVerdict =
  // The token's pid is provably not running any more.
  | "dead"
  // The token's pid is running, and a fresh identity read positively
  // matches the recorded token - the same process.
  | "alive-same"
  // The token's pid is running, but a fresh identity read positively
  // differs from the recorded token - the OS recycled the pid onto an
  // unrelated process.
  | "alive-different"
  // Liveness or identity could not be established either way (probe
  // failure, missing tooling, or a legacy token with no recorded creation
  // stamp). Never a basis for breaking a lock or sweeping a temp dir -
  // only positive evidence (dead / alive-different) is.
  | "indeterminate";

// Pure decision function, kept separate from the OS-querying wrapper below
// so the branch logic is exhaustively unit-testable without shelling out -
// recycled-pid and probe-failure scenarios are impractical to reproduce
// with real OS processes in a test. Takes the tri-state liveness verdict
// directly (never the collapsed `isProcessAlive` boolean) so a probe
// failure can only ever produce "indeterminate", never masquerade as
// "dead" break evidence.
//
// Deliberately does NOT short-circuit on `liveness === "indeterminate"`:
// the liveness probe (`kill`/`tasklist`) and the identity probe (`/proc`,
// `ps`, `Get-Process`) are independent OS queries, and one can fail while
// the other succeeds. An identity read that positively SUCCEEDS despite an
// indeterminate liveness result is still real evidence - a mismatch means
// whatever now occupies that pid is not the recorded holder (breakable),
// and a match means it plausibly still is. Only when the identity
// comparison itself has nothing to go on (a failed read, or no recorded
// identity) does the result fall back to "indeterminate".
//
// ### Why this compares stamps and not timestamps
//
// It used to take two epoch-millisecond start times and call them the same
// process within a symmetric 5s tolerance. Both were derived as
// `Date.now() - <elapsed since start>` - an elapsed term measured from boot,
// anchored to the realtime clock - and taken at two different moments. A
// `CLOCK_REALTIME` step larger than the tolerance between recording a token
// and verifying it therefore moved one operand and not the other, and the
// function answered "alive-different": positive, confident evidence that a
// live lock holder was a recycled pid. Callers act on exactly that by
// BREAKING the holder's lock, so on a machine whose clock steps - WSL2
// resuming a paused VM, a laptop waking, NTP correcting - two processes
// could end up inside the same critical section.
//
// This is the same defect as traycerai/traycer#740, which reached users
// through `getPublishedProcessIdentityVerdict`. The tolerance was never the
// problem and no value for it would have helped; the operands were.
// `ProcessStartIdentity` is recorded once by the kernel and only read back,
// so the comparison is exact equality and no clock can reach it.
export function computeProcessIdentityVerdict(
  liveness: ProcessLivenessVerdict,
  recordedIdentity: ProcessStartIdentity | null,
  observedIdentity: ProcessStartIdentity | null,
): ProcessIdentityVerdict {
  return processIdentityVerdictOf(
    liveness,
    compareProcessStartIdentity(recordedIdentity, observedIdentity),
  );
}

// `computeProcessIdentityVerdict` over a comparison already made - the form
// the verifiers below use, since their observation may be a denied read's
// WMI creation time rather than a token.
function processIdentityVerdictOf(
  liveness: ProcessLivenessVerdict,
  match: ProcessStartIdentityMatch,
): ProcessIdentityVerdict {
  if (liveness === "dead") return "dead";
  switch (match) {
    case "same":
      return "alive-same";
    case "different":
      return "alive-different";
    case "unknown":
      return "indeterminate";
  }
}

// This process's own creation stamp, cached for the life of the process once
// a probe has produced it (a process's own stamp never changes - that is the
// whole point of it). Backs the own-pid identity check below; unlike the
// general cross-pid path there is nothing to gain from re-probing on every
// call.
//
// Only an ANSWER is cached. A failed probe is a fact about that moment - on
// Windows it is a PowerShell spawn with a timeout, which a loaded machine can
// outlast - not about the process, and caching it made one slow boot probe
// cost a desktop its presence record, and with it Linked's crash guarantee,
// for its whole life (F-WIN-2). The ASYNC read retries instead: a failure is
// remembered for `OWN_START_IDENTITY_RETRY_MS`, so callers asking in a loop do
// not spawn a probe each, and the next async read after that probes again.
// The SYNCHRONOUS read still probes at most once per process: it blocks its
// caller's event loop (a PowerShell spawn on Windows), and its callers - lock
// acquisition among them - must not cost a spawn per call. It answers from
// whatever the cache holds, so a stamp the async read found later reaches it.
//
// Once a stamp is cached it is never replaced, so "what we wrote" and "what
// we are" stay one value: the only transition is from no stamp to the stamp.
let cachedOwnStartIdentity: ProcessStartIdentity | null = null;
let ownStartIdentityProbed = false;
let ownStartIdentityFailedAtMs: number | null = null;

/** How long a failed own-identity probe is answered from memory (async). */
export const OWN_START_IDENTITY_RETRY_MS = 5_000;

function ownStartIdentityFailureIsFresh(): boolean {
  return (
    ownStartIdentityFailedAtMs !== null &&
    Date.now() - ownStartIdentityFailedAtMs < OWN_START_IDENTITY_RETRY_MS
  );
}

function settleOwnStartIdentity(
  identity: ProcessStartIdentity | null,
): ProcessStartIdentity | null {
  ownStartIdentityProbed = true;
  if (cachedOwnStartIdentity !== null) return cachedOwnStartIdentity;
  if (identity === null) {
    ownStartIdentityFailedAtMs = Date.now();
    return null;
  }
  cachedOwnStartIdentity = identity;
  ownStartIdentityFailedAtMs = null;
  return identity;
}

/**
 * This process's own creation stamp, or `null` when no probe has produced one
 * yet. Exported for a writer that stamps its own identity into a record
 * another process will later hold against `verifyProcessIdentity` (the CLI's
 * update-progress marker): stamping from the cached read that the own-pid
 * verdict compares against keeps "what we wrote" and "what we are" one value.
 * Probes only when no probe has run yet (see the cache above); a stamp once
 * read is final.
 */
export function ownProcessStartIdentity(): ProcessStartIdentity | null {
  if (cachedOwnStartIdentity !== null) return cachedOwnStartIdentity;
  if (ownStartIdentityProbed) return null;
  return settleOwnStartIdentity(readProcessStartIdentity(process.pid));
}

let ownStartIdentityAsyncRead: Promise<ProcessStartIdentity | null> | null =
  null;

/**
 * {@link ownProcessStartIdentity} through the ASYNC probe, for a process that
 * must not block its event loop on it: the synchronous read spawns PowerShell
 * on Windows, which stalls Electron main for seconds. Its answer seeds the
 * same cache the synchronous read uses, so the two can never disagree about
 * what this process is. Concurrent callers share one probe; a probe that
 * produced nothing is released, so the next call after the retry window
 * probes again rather than inheriting the failure.
 */
export function ownProcessStartIdentityAsync(): Promise<ProcessStartIdentity | null> {
  if (cachedOwnStartIdentity !== null) {
    return Promise.resolve(cachedOwnStartIdentity);
  }
  if (ownStartIdentityAsyncRead !== null) return ownStartIdentityAsyncRead;
  if (ownStartIdentityFailureIsFresh()) return Promise.resolve(null);
  const read = asyncProcessStartIdentityReader(process.pid).then(
    (identity) => settleOwnStartIdentity(identity),
    () => settleOwnStartIdentity(null),
  );
  const settled = read.finally(() => {
    if (ownStartIdentityAsyncRead === settled) ownStartIdentityAsyncRead = null;
  });
  ownStartIdentityAsyncRead = settled;
  return settled;
}

// Test-only seam: forget this process's own identity - a cached stamp and a
// remembered failure alike - so a suite can drive the cache from empty.
export function __resetOwnStartIdentityForTest(): void {
  cachedOwnStartIdentity = null;
  ownStartIdentityProbed = false;
  ownStartIdentityFailedAtMs = null;
  ownStartIdentityAsyncRead = null;
}

// A token recorded under our own pid still needs an identity check, not
// an unconditional "alive-same": if the OS recycled this pid onto us
// since the token was written (the token's process is a dead
// predecessor, not this process), returning "alive-same" would wedge a
// lock/temp forever under a holder that no longer exists. Positive
// evidence either way is drawn from comparing the recorded creation stamp
// against our own, positively-known one - never from re-probing our own
// liveness, which is trivially always "alive" and therefore uninformative
// here.
//
// This arm mattered most for the clock bug: it maps a difference to "dead",
// so under the old timestamp comparison a clock step could make a process
// declare its OWN live token that of a dead predecessor.
function verifyOwnProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  const ownIdentity = ownProcessStartIdentity();
  switch (compareProcessStartIdentity(token.startIdentity, ownIdentity)) {
    case "same":
      return "alive-same";
    case "unknown":
      // Our own write after a failed probe, or a token written before the
      // field existed - no identity claim to check against either way.
      return "indeterminate";
    case "different":
      break;
  }
  // The recorded identity doesn't match ours - the pid was recycled onto
  // us since that token was written, so its writer is positively gone.
  return "dead";
}

export function verifyProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  if (token.pid === process.pid) return verifyOwnProcessIdentity(token);
  const liveness = probeProcessLiveness(token.pid);
  // Attempt the identity read whenever liveness didn't already prove the pid
  // dead - including "indeterminate" liveness, since a successful identity
  // read is independent positive evidence (see
  // `computeProcessIdentityVerdict`'s comment). Skip it when the token
  // carries nothing to compare against: the verdict would be "indeterminate"
  // either way, and this runs per candidate on every lock acquisition.
  const observed =
    liveness === "dead" || token.startIdentity === null
      ? null
      : observeProcessStart(token.pid, token.startIdentity);
  return processIdentityVerdictOf(
    liveness,
    compareObservedProcessStart(token.startIdentity, observed),
  );
}

// Same verdict as `verifyProcessIdentity`, without blocking the event loop.
// The synchronous form shells out via `execFileSync` (a 3s timeout and up to
// three retries on POSIX), which is fine for a lock acquisition that is
// about to block anyway but not for a caller that judges MANY tokens in a
// row before doing any work - `registry/download-cache.ts` sweeps every
// entry in the download cache before a download is allowed to start, and a
// cache holding a handful of distinct stale owners could otherwise burn tens
// of seconds of wall clock with the process wedged and emitting nothing.
export async function verifyProcessIdentityAsync(
  token: ProcessIdentityToken,
): Promise<ProcessIdentityVerdict> {
  if (token.pid === process.pid) return verifyOwnProcessIdentity(token);
  const liveness = await asyncProcessLivenessReader(token.pid);
  const observed =
    liveness === "dead" || token.startIdentity === null
      ? null
      : await observeProcessStartAsync(token.pid, token.startIdentity);
  return processIdentityVerdictOf(
    liveness,
    compareObservedProcessStart(token.startIdentity, observed),
  );
}

// Mutable indirection for the start-time probe `verifyProcessIdentity`
// consults, defaulting to the real `readProcessStartTimeMs` below. Exists
// solely so tests can force a probe failure for a specific pid at the
// exact boundary the decision logic reads from: `vi.mock`'s module-export
// replacement only intercepts calls made by OTHER modules importing this
// one, not `verifyProcessIdentity`'s own same-module call to
// `readProcessStartTimeMs` - see the CLI's Fixup round-2 ticket's item F.
// Production code never calls `__setProcessStartTimeReaderForTest`.
let processStartTimeReader: (pid: number) => number | null =
  readProcessStartTimeMsImpl;
let asyncProcessLivenessReader: (
  pid: number,
) => Promise<ProcessLivenessVerdict> = probeProcessLivenessAsyncImpl;

// Test-only seam - pass `null` to restore the default reader. Returns the
// previous reader so tests can save/restore symmetrically.
export function __setProcessStartTimeReaderForTest(
  next: ((pid: number) => number | null) | null,
): (pid: number) => number | null {
  const previous = processStartTimeReader;
  processStartTimeReader = next === null ? readProcessStartTimeMsImpl : next;
  return previous;
}

export function __setAsyncProcessLivenessReaderForTest(
  next: ((pid: number) => Promise<ProcessLivenessVerdict>) | null,
): (pid: number) => Promise<ProcessLivenessVerdict> {
  const previous = asyncProcessLivenessReader;
  asyncProcessLivenessReader =
    next === null ? probeProcessLivenessAsyncImpl : next;
  return previous;
}

export function readProcessStartTimeMs(pid: number): number | null {
  return readProcessStartTimeMsImpl(pid);
}

// This process's own start time, read once and cached like
// `ownProcessStartIdentity`: a process's start time never changes, and the
// read is a `ps`/`powershell` spawn on macOS and Windows. Backs every lock
// acquisition's metadata (`cross-process-lock.ts`), which used to pay the
// spawn per acquisition - and the update-progress marker lock now
// acquires several times per `host update`. Reads the raw reader, not the
// test seam: the seam models OTHER processes' probes.
let cachedOwnStartTimeMs: number | null | "unread" = "unread";
export function ownProcessStartTimeMs(): number | null {
  if (cachedOwnStartTimeMs === "unread") {
    cachedOwnStartTimeMs = readProcessStartTimeMsImpl(process.pid);
  }
  return cachedOwnStartTimeMs;
}

function readProcessStartTimeMsImpl(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === "win32"
    ? readWindowsProcessStartTimeMs(pid)
    : readPosixProcessStartTimeMs(pid);
}

function readPosixProcessStartTimeMs(pid: number): number | null {
  for (
    let retry = 0;
    retry <= POSIX_PROCESS_START_TIME_MAX_RETRIES;
    retry += 1
  ) {
    let stdout: string;
    try {
      stdout = execFileSync("ps", ["-p", String(pid), "-o", "etime="], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
    const elapsedSeconds = parseElapsedSeconds(stdout.trim());
    if (elapsedSeconds === null) return null;
    const startedAtMs = processStartTimeMsFromElapsedSeconds(
      elapsedSeconds,
      Date.now(),
      uptime(),
    );
    if (startedAtMs !== null) return startedAtMs;
  }
  return null;
}

function processStartTimeMsFromElapsedSeconds(
  elapsedSeconds: number,
  nowMs: number,
  uptimeSeconds: number,
): number | null {
  if (
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < 0 ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(uptimeSeconds) ||
    uptimeSeconds < 0 ||
    elapsedSeconds > uptimeSeconds + POSIX_ELAPSED_UPTIME_SLACK_SECONDS
  ) {
    return null;
  }
  const startedAtMs = nowMs - elapsedSeconds * 1000;
  return Number.isFinite(startedAtMs) &&
    startedAtMs >= 0 &&
    startedAtMs <= nowMs
    ? startedAtMs
    : null;
}

// Parses `ps -o etime=` output: `[[dd-]hh:]mm:ss`. Elapsed time (not a
// wall-clock date) sidesteps `ps`'s locale-dependent date formatting
// entirely - the alternative (`lstart`) would need locale-aware parsing.
function parseElapsedSeconds(etime: string): number | null {
  const withDays = etime.match(/^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/);
  if (withDays !== null) {
    const [, d, h, m, s] = withDays;
    return Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const withHours = etime.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (withHours !== null) {
    const [, h, m, s] = withHours;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const minutesOnly = etime.match(/^(\d{1,2}):(\d{2})$/);
  if (minutesOnly !== null) {
    const [, m, s] = minutesOnly;
    return Number(m) * 60 + Number(s);
  }
  return null;
}

function readWindowsProcessStartTimeMs(pid: number): number | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return null;
  }
  const parsed = Date.parse(stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// ---- Clock-immune start identity ------------------------------------------
//
// Every reader above answers "when did this process start?" with a value
// derived from the wall clock at read time, which is why none of them survives
// a `CLOCK_REALTIME` step (see `getPublishedProcessIdentityVerdict`). The
// readers below answer a narrower question - "which process instance is
// this?" - by fetching a stamp the kernel wrote once at process creation and
// never recomputes. Two reads return identical bytes however the clock has
// been adjusted in between, so the comparison is exact equality and needs no
// tolerance at all.
//
// The macOS reader deliberately reverses the `etime`-over-`lstart` choice
// documented above `parseElapsedSeconds`. Avoiding `ps`'s locale-dependent
// date formatting is right for the elapsed-time question; for this one it is
// the disease, because elapsed time is precisely the thing that has to be
// re-anchored to a clock. So `lstart` is read under a pinned locale and
// timezone and compared AS TEXT - never parsed into a timestamp, which would
// let a locale change or a tzdata update reintroduce the drift by the back
// door.

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

// The stored stamp has to format identically on every read, so the probe pins
// locale and timezone instead of inheriting the user's shell.
const DETERMINISTIC_FORMAT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  LC_ALL: "C",
  TZ: "UTC",
};

// A boot id cannot change within a boot, and a `/proc` that could not be read
// once (masked in a container, an exotic mount namespace) will not start
// working later - so both the value and the failure are cached.
let cachedLinuxBootId: string | null | "unread" = "unread";

function readLinuxBootId(): string | null {
  if (cachedLinuxBootId === "unread") {
    try {
      cachedLinuxBootId = readFileSync(LINUX_BOOT_ID_PATH, "utf8").trim();
    } catch {
      cachedLinuxBootId = null;
    }
  }
  return cachedLinuxBootId;
}

// Field 22 of `/proc/<pid>/stat`. Field 2 is `comm` - the executable name in
// parentheses, which may itself contain spaces and ')' - so the only safe
// place to begin splitting is the LAST ')' in the record. The field after it
// is #3, which puts field N at index N - 3.
function parseLinuxStartTicks(stat: string): number | null {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/u);
  const raw = fields[19];
  if (raw === undefined) return null;
  const ticks = Number(raw);
  return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
}

function buildLinuxProcessStartIdentity(
  stat: string,
): ProcessStartIdentity | null {
  const bootId = readLinuxBootId();
  if (bootId === null) return null;
  const ticks = parseLinuxStartTicks(stat);
  return ticks === null ? null : formatLinuxProcessStartIdentity(bootId, ticks);
}

function linuxProcStatPath(pid: number): string {
  return `/proc/${String(pid)}/stat`;
}

function windowsCreationTimeArgs(pid: number): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`,
  ];
}

function darwinLstartArgs(pid: number): readonly string[] {
  return ["-p", String(pid), "-o", "lstart="];
}

function readProcessStartIdentityImpl(
  pid: number,
): ProcessStartIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      return buildLinuxProcessStartIdentity(
        readFileSync(linuxProcStatPath(pid), "utf8"),
      );
    }
    if (process.platform === "win32") {
      return formatWindowsProcessStartIdentity(
        execFileSync("powershell", windowsCreationTimeArgs(pid), {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          env: DETERMINISTIC_FORMAT_ENV,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    }
    return formatDarwinProcessStartIdentity(
      execFileSync("ps", darwinLstartArgs(pid), {
        encoding: "utf8",
        timeout: 3000,
        env: DETERMINISTIC_FORMAT_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    // A dead pid, a denied probe, missing tooling: no token, and every caller
    // reads the absence as "cannot compare", never as evidence of anything.
    return null;
  }
}

const WINDOWS_START_IDENTITY_TIMEOUT_MS = 5_000;

// This process's OWN stamp, read asynchronously, gets three times the room.
// Measured on a Windows Server 2022 VM (node 24.20, the exact call below): 193-
// 227 ms warm or cold, but 4.2-4.6 s when the caller runs at BelowNormal - as
// a desktop launched by Task Scheduler does, its PowerShell child inheriting
// that priority - against four busy Normal-priority loops, and one such boot
// crossed the old 5 s. Nothing waits on this read but the presence write,
// and a failure costs that record until a retry lands (F-WIN-2), so the wait
// is the cheaper side.
const OWN_WINDOWS_START_IDENTITY_TIMEOUT_MS = 15_000;

async function readProcessStartIdentityAsyncImpl(
  pid: number,
): Promise<ProcessStartIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return buildLinuxProcessStartIdentity(
        await readFile(linuxProcStatPath(pid), "utf8"),
      );
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const stdout = await execFileOutput(
      "powershell",
      windowsCreationTimeArgs(pid),
      pid === process.pid
        ? OWN_WINDOWS_START_IDENTITY_TIMEOUT_MS
        : WINDOWS_START_IDENTITY_TIMEOUT_MS,
      DETERMINISTIC_FORMAT_ENV,
    );
    return stdout === null ? null : formatWindowsProcessStartIdentity(stdout);
  }
  const stdout = await execFileOutput(
    "ps",
    darwinLstartArgs(pid),
    3_000,
    DETERMINISTIC_FORMAT_ENV,
  );
  return stdout === null ? null : formatDarwinProcessStartIdentity(stdout);
}

let asyncProcessStartIdentityReader: (
  pid: number,
) => Promise<ProcessStartIdentity | null> = readProcessStartIdentityAsyncImpl;

// Test-only seam - pass `null` to restore the default reader. Returns the
// previous reader so tests can save/restore symmetrically.
export function __setAsyncProcessStartIdentityReaderForTest(
  next: ((pid: number) => Promise<ProcessStartIdentity | null>) | null,
): (pid: number) => Promise<ProcessStartIdentity | null> {
  const previous = asyncProcessStartIdentityReader;
  asyncProcessStartIdentityReader =
    next === null ? readProcessStartIdentityAsyncImpl : next;
  return previous;
}

/**
 * The kernel's creation stamp for `pid`, or `null` when this platform could
 * not produce one. Stable across any wall-clock adjustment; see the section
 * comment above.
 *
 * The exact read ONLY, on purpose: this is also the RECORDING read -
 * `host-update/lock.ts` writes it into the attempt lock for a rebind pid, and
 * this process's own token comes from it - and a token must always be the
 * exact round-trip string. Do not add the denied-read fallback here: a WMI
 * creation time recorded as a token would compare as `"different"` against
 * every later exact read of the same process. Verifiers use
 * {@link observeProcessStart} / {@link matchLiveProcessStartIdentity}.
 */
export function readProcessStartIdentity(
  pid: number,
): ProcessStartIdentity | null {
  return processStartIdentityReader(pid);
}

let processStartIdentityReader: (pid: number) => ProcessStartIdentity | null =
  readProcessStartIdentityImpl;

// Test-only seam, the synchronous twin of
// `__setAsyncProcessStartIdentityReaderForTest` - pass `null` to restore the
// default reader. Returns the previous reader.
export function __setProcessStartIdentityReaderForTest(
  next: ((pid: number) => ProcessStartIdentity | null) | null,
): (pid: number) => ProcessStartIdentity | null {
  const previous = processStartIdentityReader;
  processStartIdentityReader =
    next === null ? readProcessStartIdentityImpl : next;
  return previous;
}

// ---- Verifying reads: the exact token, or a denied read's WMI answer ------
//
// A Windows exact read is DENIED for a process in another security context:
// session 0 (a service), another user, or this user at a higher integrity
// level - an elevated `traycer host update` or installer holding a lock, read
// by an unelevated CLI. Before this fallback every verifier read that as
// "cannot compare", indefinitely: a desktop whose pid a service (WmiPrvSE)
// took over inside the presence probe's grace kept its supervisor from ever
// seeing it gone, and a lock whose dead holder's pid was reused the same way
// was never released. So a VERIFYING read whose exact read was denied - and
// only denied; a timeout, an exit or any other failure stays "cannot
// compare" - asks WMI for the process's creation time, and the protocol's
// `compareObservedProcessStart` decides at the microsecond within 1 µs. It
// decides BOTH ways: "different" is the reuse evidence the waiters need, and
// "same" is required too, because the elevated holder is alive and ours and a
// false "different" would break its live lock. A failed or empty WMI read
// stays `null` - "cannot compare" - exactly as today. A pid whose exact read
// succeeds never takes the fallback, so every value recorded today compares
// exactly as it always has.

/**
 * What a verifier sees for `pid`: the exact token, or - only when the exact
 * read was denied on Windows - WMI's creation time for the process. `recorded`
 * is the token being verified; when it is not a Windows token there is
 * nothing a creation time could be compared against, so the fallback is not
 * spawned.
 */
function observeProcessStart(
  pid: number,
  recorded: ProcessStartIdentity | null,
): ObservedProcessStart | null {
  const identity = processStartIdentityReader(pid);
  if (identity !== null) return { kind: "identity", identity };
  if (windowsProcessStartIdentityMicros(recorded) === null) return null;
  const creationMicros = windowsDeniedReadCreationReader(pid);
  return creationMicros === null
    ? null
    : { kind: "windows-denied-read", creationMicros };
}

async function observeProcessStartAsync(
  pid: number,
  recorded: ProcessStartIdentity | null,
): Promise<ObservedProcessStart | null> {
  const identity = await asyncProcessStartIdentityReader(pid);
  if (identity !== null) return { kind: "identity", identity };
  if (windowsProcessStartIdentityMicros(recorded) === null) return null;
  const creationMicros = await asyncWindowsDeniedReadCreationReader(pid);
  return creationMicros === null
    ? null
    : { kind: "windows-denied-read", creationMicros };
}

/**
 * Is the live process at `pid` the one `recorded` names? The comparison
 * `verifyProcessIdentity` makes, for a caller that has already established
 * liveness its own way - `"unknown"` whenever no comparison could be made.
 */
export function matchLiveProcessStartIdentity(
  pid: number,
  recorded: ProcessStartIdentity | null,
): ProcessStartIdentityMatch {
  if (recorded === null) return "unknown";
  return compareObservedProcessStart(
    recorded,
    observeProcessStart(pid, recorded),
  );
}

function windowsDeniedReadFallbackArgs(pid: number): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    buildWindowsDeniedReadFallbackScript(pid),
  ];
}

function readWindowsDeniedReadCreationMicrosImpl(pid: number): number | null {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    return parseWindowsDeniedReadFallbackOutput(
      execFileSync("powershell", windowsDeniedReadFallbackArgs(pid), {
        encoding: "utf8",
        windowsHide: true,
        timeout: WINDOWS_START_IDENTITY_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    // No such process, any failure other than a denied read, a timeout: the
    // script exits non-zero and there is nothing to compare.
    return null;
  }
}

async function readWindowsDeniedReadCreationMicrosAsyncImpl(
  pid: number,
): Promise<number | null> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const stdout = await execFileOutput(
    "powershell",
    windowsDeniedReadFallbackArgs(pid),
    WINDOWS_START_IDENTITY_TIMEOUT_MS,
    undefined,
  );
  return stdout === null ? null : parseWindowsDeniedReadFallbackOutput(stdout);
}

let windowsDeniedReadCreationReader: (pid: number) => number | null =
  readWindowsDeniedReadCreationMicrosImpl;
let asyncWindowsDeniedReadCreationReader: (
  pid: number,
) => Promise<number | null> = readWindowsDeniedReadCreationMicrosAsyncImpl;

// Test-only seams for the denied-read fallback (UTC epoch microseconds, or
// `null` for no answer) - pass `null` to restore the default reader. Each
// returns the previous reader.
export function __setWindowsDeniedReadCreationReaderForTest(
  next: ((pid: number) => number | null) | null,
): (pid: number) => number | null {
  const previous = windowsDeniedReadCreationReader;
  windowsDeniedReadCreationReader =
    next === null ? readWindowsDeniedReadCreationMicrosImpl : next;
  return previous;
}

export function __setAsyncWindowsDeniedReadCreationReaderForTest(
  next: ((pid: number) => Promise<number | null>) | null,
): (pid: number) => Promise<number | null> {
  const previous = asyncWindowsDeniedReadCreationReader;
  asyncWindowsDeniedReadCreationReader =
    next === null ? readWindowsDeniedReadCreationMicrosAsyncImpl : next;
  return previous;
}

function execFileOutput(
  command: string,
  args: readonly string[],
  timeout: number,
  // `undefined` inherits this process's environment. Only the start-identity
  // probes override it, to pin the formatting of a stored stamp.
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", windowsHide: true, timeout, env },
      (err, stdout) => resolve(err === null ? stdout : null),
    );
  });
}

async function probeProcessLivenessAsyncImpl(
  pid: number,
): Promise<ProcessLivenessVerdict> {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (err) {
      const code = isErrnoException(err) ? err.code : null;
      if (code === "EPERM") return "alive";
      return code === "ESRCH" ? "dead" : "indeterminate";
    }
  }
  const stdout = await execFileOutput(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
    3_000,
    undefined,
  );
  if (stdout === null) return "indeterminate";
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.startsWith("INFO:")) return "dead";
  return trimmed.includes(`"${pid}"`) ? "alive" : "dead";
}

// Exported for tests so the fixed-format parser can be exercised directly
// without shelling out to `ps`.
export const __parseElapsedSecondsForTest = parseElapsedSeconds;
export const __processStartTimeMsFromElapsedSecondsForTest =
  processStartTimeMsFromElapsedSeconds;
