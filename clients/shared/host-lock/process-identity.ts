import { execFile, execFileSync } from "node:child_process";

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
// CSV body is non-empty.
function probeProcessLiveness(pid: number): ProcessLivenessVerdict {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (process.platform === "win32") {
    let stdout: string;
    try {
      stdout = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
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
export function readLiveProcessStartTimeMs(pid: number): number | null {
  return probeProcessLiveness(pid) === "alive"
    ? processStartTimeReader(pid)
    : null;
}

// pid.json is published only after the host has started. A process whose OS
// start time is later than that publication cannot be the publisher - the PID
// has been recycled onto an unrelated occupant. Keep a small allowance for
// whole-second process-start probes and clock granularity; it never admits a
// process that began meaningfully after the metadata was written.
const PID_METADATA_PUBLICATION_ALLOWANCE_MS = 1_250;

export function isPublishedProcessIdentityCurrent(
  pid: number,
  publishedAt: string | null,
): boolean {
  if (publishedAt === null) return false;
  const publishedAtMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedAtMs)) return false;
  const processStartedAtMs = readLiveProcessStartTimeMs(pid);
  if (processStartedAtMs === null) return false;
  return (
    processStartedAtMs <= publishedAtMs + PID_METADATA_PUBLICATION_ALLOWANCE_MS
  );
}

export type PublishedProcessIdentityVerdict =
  "current" | "mismatch" | "dead" | "indeterminate";

// Electron-main checks an advertised endpoint first. Once the handshake has
// established positive liveness, identity only rules out a positively
// demonstrated recycled-PID impostor; a failed OS probe is deliberately
// inconclusive rather than evidence the healthy endpoint is down.
export async function getPublishedProcessIdentityVerdict(
  pid: number,
  publishedAt: string | null,
): Promise<PublishedProcessIdentityVerdict> {
  const liveness = await asyncProcessLivenessReader(pid);
  if (liveness === "dead") return "dead";
  if (liveness !== "alive") return "indeterminate";
  if (publishedAt === null) return "indeterminate";
  const publishedAtMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedAtMs)) return "indeterminate";
  const processStartedAtMs = await asyncProcessStartTimeReader(pid);
  if (processStartedAtMs === null) return "indeterminate";
  return processStartedAtMs >
    publishedAtMs + PID_METADATA_PUBLICATION_ALLOWANCE_MS
    ? "mismatch"
    : "current";
}

// ---- Identity (pid + process-start-time) -----------------------------------

export interface ProcessIdentityToken {
  readonly pid: number;
  // Milliseconds since epoch, best-effort. `null` when the platform probe
  // failed at capture time (permissions, missing tooling, or a legacy
  // token written before this field existed) - a token with a null start
  // time can never positively confirm "same process", only "some process
  // is alive at this pid" via `isProcessAlive`.
  readonly startedAtMs: number | null;
}

export function currentProcessIdentityToken(): ProcessIdentityToken {
  return {
    pid: process.pid,
    startedAtMs: readProcessStartTimeMs(process.pid),
  };
}

// Two independent reads of the same still-running process's start time can
// differ by a couple of seconds: POSIX `ps -o etime=` has whole-second
// resolution, and each read floors the elapsed time as of a different
// wall-clock moment. This tolerance absorbs that jitter without risking a
// false "same identity" match against a genuinely different process - a
// real pid-reuse collision landing inside a 5s window of the original
// process's start is not a realistic adversary for this mechanism.
const START_TIME_MATCH_TOLERANCE_MS = 5000;

export type ProcessIdentityVerdict =
  // The token's pid is provably not running any more.
  | "dead"
  // The token's pid is running, and a fresh start-time read positively
  // matches the recorded token - the same process.
  | "alive-same"
  // The token's pid is running, but a fresh start-time read positively
  // differs from the recorded token - the OS recycled the pid onto an
  // unrelated process.
  | "alive-different"
  // Liveness or start-time could not be established either way (probe
  // failure, missing tooling, or a legacy token with no recorded start
  // time). Never a basis for breaking a lock or sweeping a temp dir -
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
// the liveness probe (`kill`/`tasklist`) and the start-time probe (`ps`/
// `Get-Process`) are independent OS queries, and one can fail while the
// other succeeds. A start-time read that positively SUCCEEDS despite an
// indeterminate liveness result is still real evidence - a mismatch means
// whatever now occupies that pid is not the recorded holder (breakable),
// and a match means it plausibly still is. Only when the start-time
// comparison itself has nothing to go on (a failed read, or no recorded
// identity) does the result fall back to "indeterminate".
export function computeProcessIdentityVerdict(
  liveness: ProcessLivenessVerdict,
  recordedStartedAtMs: number | null,
  currentStartedAtMs: number | null,
): ProcessIdentityVerdict {
  if (liveness === "dead") return "dead";
  if (recordedStartedAtMs === null || currentStartedAtMs === null) {
    return "indeterminate";
  }
  const driftMs = Math.abs(currentStartedAtMs - recordedStartedAtMs);
  return driftMs <= START_TIME_MATCH_TOLERANCE_MS
    ? "alive-same"
    : "alive-different";
}

// This process's own start time, read once and cached for the life of
// the process (a process's own start time never changes). Backs the
// own-pid identity check below - unlike the general cross-pid path,
// there is nothing to gain from re-probing on every call.
let cachedOwnStartTimeMs: number | null | "unread" = "unread";
function ownProcessStartTimeMs(): number | null {
  if (cachedOwnStartTimeMs === "unread") {
    cachedOwnStartTimeMs = readProcessStartTimeMs(process.pid);
  }
  return cachedOwnStartTimeMs;
}

// A token recorded under our own pid still needs an identity check, not
// an unconditional "alive-same": if the OS recycled this pid onto us
// since the token was written (the token's process is a dead
// predecessor, not this process), returning "alive-same" would wedge a
// lock/temp forever under a holder that no longer exists. Positive
// evidence either way is drawn from comparing the recorded start time
// against our own, positively-known start time - never from re-probing
// our own liveness, which is trivially always "alive" and therefore
// uninformative here.
function verifyOwnProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  if (token.startedAtMs === null) {
    // Could be our own write after a failed start-time probe - no
    // identity claim was ever recorded to check against.
    return "indeterminate";
  }
  const ownStartedAtMs = ownProcessStartTimeMs();
  if (ownStartedAtMs === null) return "indeterminate";
  const driftMs = Math.abs(ownStartedAtMs - token.startedAtMs);
  if (driftMs <= START_TIME_MATCH_TOLERANCE_MS) return "alive-same";
  // The recorded identity doesn't match ours - the pid was recycled onto
  // us since that token was written, so its writer is positively gone.
  return "dead";
}

export function verifyProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  if (token.pid === process.pid) return verifyOwnProcessIdentity(token);
  const liveness = probeProcessLiveness(token.pid);
  // Attempt the start-time read whenever liveness didn't already prove the
  // pid dead - including "indeterminate" liveness, since a successful
  // start-time read is independent positive evidence (see
  // `computeProcessIdentityVerdict`'s comment).
  const currentStartedAtMs =
    liveness === "dead" ? null : processStartTimeReader(token.pid);
  return computeProcessIdentityVerdict(
    liveness,
    token.startedAtMs,
    currentStartedAtMs,
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
let asyncProcessStartTimeReader: (pid: number) => Promise<number | null> =
  readProcessStartTimeMsAsyncImpl;
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

export function __setAsyncProcessStartTimeReaderForTest(
  next: ((pid: number) => Promise<number | null>) | null,
): (pid: number) => Promise<number | null> {
  const previous = asyncProcessStartTimeReader;
  asyncProcessStartTimeReader =
    next === null ? readProcessStartTimeMsAsyncImpl : next;
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

function readProcessStartTimeMsImpl(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === "win32"
    ? readWindowsProcessStartTimeMs(pid)
    : readPosixProcessStartTimeMs(pid);
}

function readPosixProcessStartTimeMs(pid: number): number | null {
  let stdout: string;
  try {
    stdout = execFileSync("ps", ["-p", String(pid), "-o", "etime="], {
      encoding: "utf8",
      timeout: 3000,
    });
  } catch {
    return null;
  }
  const elapsedSeconds = parseElapsedSeconds(stdout.trim());
  if (elapsedSeconds === null) return null;
  return Date.now() - elapsedSeconds * 1000;
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
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
  } catch {
    return null;
  }
  const parsed = Date.parse(stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function execFileOutput(
  command: string,
  args: readonly string[],
  timeout: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", windowsHide: true, timeout },
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
  );
  if (stdout === null) return "indeterminate";
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.startsWith("INFO:")) return "dead";
  return trimmed.includes(`"${pid}"`) ? "alive" : "dead";
}

async function readProcessStartTimeMsAsyncImpl(
  pid: number,
): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    const stdout = await execFileOutput(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`,
      ],
      5_000,
    );
    if (stdout === null) return null;
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  const stdout = await execFileOutput(
    "ps",
    ["-p", String(pid), "-o", "etime="],
    3_000,
  );
  if (stdout === null) return null;
  const elapsedSeconds = parseElapsedSeconds(stdout.trim());
  return elapsedSeconds === null ? null : Date.now() - elapsedSeconds * 1000;
}

// Exported for tests so the fixed-format parser can be exercised directly
// without shelling out to `ps`.
export const __parseElapsedSecondsForTest = parseElapsedSeconds;
