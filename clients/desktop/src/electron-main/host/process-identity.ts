import { execFileSync } from "node:child_process";

// Cross-platform process liveness + identity probing for the desktop-held
// `cli-lock` sections (Host Update Layer Redesign Tech Plan, "cli-lock -
// hardening and the mixed-version boundary", lock rule 3: "Electron main
// implements the identical lock protocol"). This is a deliberate,
// byte-for-byte port of `clients/traycer-cli/src/store/process-identity.ts`
// - that module is CLI-internal (not in `clients/shared`) and this ticket
// must not modify `clients/traycer-cli/`, so the desktop side carries its
// own copy rather than a cross-workspace import. Any future change to the
// CLI's copy must be mirrored here, and vice versa - see the ticket's
// "judgment calls" for the rationale.

// ---- Liveness -------------------------------------------------------------

// Tri-state result of a single liveness probe. A probe FAILURE (permission
// denied on an unrelated errno, `tasklist` missing/refused, a timeout) is
// never conflated with either "alive" or "dead" - only positive evidence may
// ever break a lock.
export type ProcessLivenessVerdict = "alive" | "dead" | "indeterminate";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof (error as { code?: unknown }).code === "string" ||
      (error as { code?: unknown }).code === undefined)
  );
}

// POSIX uses `process.kill(pid, 0)`; Windows uses
// `tasklist /FI "PID eq <pid>" /NH /FO CSV` and asserts the CSV body is
// non-empty.
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
      return "indeterminate";
    }
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return "dead";
    return trimmed.includes(`"${pid}"`) ? "alive" : "dead";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = isErrnoException(err) ? err.code : null;
    // EPERM: the pid positively exists - positive evidence of life, not a
    // probe failure.
    if (code === "EPERM") return "alive";
    // ESRCH: the kernel positively has no process at this pid.
    if (code === "ESRCH") return "dead";
    return "indeterminate";
  }
}

export function isProcessAlive(pid: number): boolean {
  return probeProcessLiveness(pid) !== "dead";
}

// ---- Identity (pid + process-start-time) -----------------------------------

export interface ProcessIdentityToken {
  readonly pid: number;
  readonly startedAtMs: number | null;
}

export function currentProcessIdentityToken(): ProcessIdentityToken {
  return {
    pid: process.pid,
    startedAtMs: readProcessStartTimeMs(process.pid),
  };
}

// Two independent reads of the same still-running process's start time can
// differ by a couple of seconds (POSIX `ps -o etime=` has whole-second
// resolution). This tolerance absorbs that jitter without risking a false
// "same identity" match against a genuinely different process.
const START_TIME_MATCH_TOLERANCE_MS = 5000;

export type ProcessIdentityVerdict =
  "dead" | "alive-same" | "alive-different" | "indeterminate";

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

let cachedOwnStartTimeMs: number | null | "unread" = "unread";
function ownProcessStartTimeMs(): number | null {
  if (cachedOwnStartTimeMs === "unread") {
    cachedOwnStartTimeMs = readProcessStartTimeMs(process.pid);
  }
  return cachedOwnStartTimeMs;
}

function verifyOwnProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  if (token.startedAtMs === null) return "indeterminate";
  const ownStartedAtMs = ownProcessStartTimeMs();
  if (ownStartedAtMs === null) return "indeterminate";
  const driftMs = Math.abs(ownStartedAtMs - token.startedAtMs);
  if (driftMs <= START_TIME_MATCH_TOLERANCE_MS) return "alive-same";
  return "dead";
}

export function verifyProcessIdentity(
  token: ProcessIdentityToken,
): ProcessIdentityVerdict {
  if (token.pid === process.pid) return verifyOwnProcessIdentity(token);
  const liveness = probeProcessLiveness(token.pid);
  const currentStartedAtMs =
    liveness === "dead" ? null : readProcessStartTimeMs(token.pid);
  return computeProcessIdentityVerdict(
    liveness,
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

// Parses `ps -o etime=` output: `[[dd-]hh:]mm:ss`.
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
