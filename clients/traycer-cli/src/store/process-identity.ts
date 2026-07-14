import { execFileSync } from "node:child_process";
import { isErrnoException } from "../runner/errors";

// Cross-platform process liveness + identity probing. Shared by the
// `cli-lock` hardening (holder identity - Tech Plan "cli-lock -
// hardening and the mixed-version boundary") and the staged store's
// owner-tokened temp sweep (Tech Plan "Stage lifecycle" step 5). Both
// mechanisms need the same answer to "is the process that wrote this
// token still the SAME process, not just the same recycled pid" -
// implemented once here so they can never drift.

// ---- Liveness -----------------------------------------------------------

// Cross-platform process-liveness probe. POSIX uses `process.kill(pid, 0)`;
// Windows uses `tasklist /FI "PID eq <pid>" /NH /FO CSV` and asserts the
// CSV body is non-empty.
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

// ---- Identity (pid + process-start-time) ---------------------------------

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
// with real OS processes in a test.
export function computeProcessIdentityVerdict(
  aliveNow: boolean,
  recordedStartedAtMs: number | null,
  currentStartedAtMs: number | null,
): ProcessIdentityVerdict {
  if (!aliveNow) return "dead";
  if (recordedStartedAtMs === null || currentStartedAtMs === null) {
    return "indeterminate";
  }
  const driftMs = Math.abs(currentStartedAtMs - recordedStartedAtMs);
  return driftMs <= START_TIME_MATCH_TOLERANCE_MS
    ? "alive-same"
    : "alive-different";
}

export function verifyProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  // The current process is always alive and always itself - short-circuit
  // without shelling out. This also makes a command's own in-flight
  // owner-tokened temp (e.g. `host download`'s not-yet-promoted stage
  // temp) correctly read as "alive-same" during its own reconcile pass.
  if (token.pid === process.pid) return "alive-same";
  const aliveNow = isProcessAlive(token.pid);
  const currentStartedAtMs = aliveNow
    ? readProcessStartTimeMs(token.pid)
    : null;
  return computeProcessIdentityVerdict(
    aliveNow,
    token.startedAtMs,
    currentStartedAtMs,
  );
}

export function readProcessStartTimeMs(pid: number): number | null {
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

// Exported for tests so the fixed-format parser can be exercised directly
// without shelling out to `ps`.
export const __parseElapsedSecondsForTest = parseElapsedSeconds;
