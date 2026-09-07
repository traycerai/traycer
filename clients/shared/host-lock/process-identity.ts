import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import {
  compareProcessStartIdentity,
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
  formatWindowsProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";

// Cross-platform process liveness + identity probing.
// Both processes need the same answer to "is the process that wrote this token still the same process, not just the same recycled pid" - implemented once here so the two never drift.

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

// ---- Liveness -------------------------------------------------------------

// Tri-state result of a single liveness probe.
export type ProcessLivenessVerdict = "alive" | "dead" | "indeterminate";

// Cross-platform process-liveness probe.
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
    // tasklist prints an `info: No tasks are running which match...` line on stderr when nothing matches; stdout is empty.
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return "dead";
    return trimmed.includes(`"${pid}"`) ? "alive" : "dead";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = isErrnoException(err) ? err.code : null;
    // Eperm: the pid positively exists (the kernel found it to check permissions against) - we just can't signal it.
    // Positive evidence of life, not a probe failure.
    if (code === "EPERM") return "alive";
    // ESRCH: the kernel positively has no process at this pid.
    if (code === "ESRCH") return "dead";
    return "indeterminate";
  }
}

// Public boolean liveness check for legacy callers (`host/busy-check.ts`, service controllers, doctor) that only need "is *something* running here" with no identity-verdict fallback to route a probe failure to.
export function isProcessAlive(pid: number): boolean {
  return probeProcessLiveness(pid) !== "dead";
}

// Read a live process's OS start time without applying identity-token equality semantics.
export function readLiveProcessStartTimeMs(pid: number): number | null {
  return probeProcessLiveness(pid) === "alive"
    ? processStartTimeReader(pid)
    : null;
}

export type PublishedProcessIdentityVerdict =
  | "current"
  | "mismatch"
  | "dead"
  | "indeterminate";

export async function getPublishedProcessIdentityVerdict(
  pid: number,
  publishedStartIdentity: ProcessStartIdentity | null,
): Promise<PublishedProcessIdentityVerdict> {
  const liveness = await asyncProcessLivenessReader(pid);
  if (liveness === "dead") return "dead";
  if (liveness !== "alive") return "indeterminate";
  // Nothing was recorded to compare against, so probing the live process cannot change the answer - `compareProcessStartIdentity` would return "unknown" whatever comes back.
  if (publishedStartIdentity === null) return "indeterminate";
  const observed = await asyncProcessStartIdentityReader(pid);
  switch (compareProcessStartIdentity(publishedStartIdentity, observed)) {
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
   * Delete it only once no supported version reads it.
   */
  readonly startedAtMs: number | null;
  /**
   * The kernel's creation stamp for this process - the operand every verdict below actually compares.
   * `null` when the platform probe failed, or when the token was written before this field existed; both mean "cannot compare", never "different process".
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
  // The token's pid is running, but a fresh identity read positively differs from the recorded token - the OS recycled the pid onto an unrelated process.
  | "alive-different"
  // Liveness or identity could not be established either way (probe failure, missing tooling, or a legacy token with no recorded creation stamp).
  // Never a basis for breaking a lock or sweeping a temp dir - only positive evidence (dead / alive-different) is.
  | "indeterminate";

  // Takes the tri-state liveness verdict directly (never the collapsed `isProcessAlive` boolean) so a probe failure can only ever produce "indeterminate", never masquerade as "dead" break evidence.
// Only when the identity comparison itself has nothing to go on (a failed read, or no recorded identity) does the result fall back to "indeterminate".
export function computeProcessIdentityVerdict(
  liveness: ProcessLivenessVerdict,
  recordedIdentity: ProcessStartIdentity | null,
  observedIdentity: ProcessStartIdentity | null,
): ProcessIdentityVerdict {
  if (liveness === "dead") return "dead";
  switch (compareProcessStartIdentity(recordedIdentity, observedIdentity)) {
    case "same":
      return "alive-same";
    case "different":
      return "alive-different";
    case "unknown":
      return "indeterminate";
  }
}

// This process's own creation stamp, read once and cached for the life of the process (a process's own stamp never changes - that is the whole point of it).
let cachedOwnStartIdentity: ProcessStartIdentity | null | "unread" = "unread";
function ownProcessStartIdentity(): ProcessStartIdentity | null {
  if (cachedOwnStartIdentity === "unread") {
    cachedOwnStartIdentity = readProcessStartIdentity(process.pid);
  }
  return cachedOwnStartIdentity;
}

// This arm mattered most for the clock bug: it maps a difference to "dead", so under the old timestamp comparison a clock step could make a process declare its own live token that of a dead predecessor.
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
  // Skip it when the token carries nothing to compare against: the verdict would be "indeterminate" either way, and this runs per candidate on every lock acquisition.
  const observedIdentity =
    liveness === "dead" || token.startIdentity === null
      ? null
      : readProcessStartIdentity(token.pid);
  return computeProcessIdentityVerdict(
    liveness,
    token.startIdentity,
    observedIdentity,
  );
}

// Same verdict as `verifyProcessIdentity`, without blocking the event loop.
export async function verifyProcessIdentityAsync(
  token: ProcessIdentityToken,
): Promise<ProcessIdentityVerdict> {
  if (token.pid === process.pid) return verifyOwnProcessIdentity(token);
  const liveness = await asyncProcessLivenessReader(token.pid);
  const observedIdentity =
    liveness === "dead" || token.startIdentity === null
      ? null
      : await asyncProcessStartIdentityReader(token.pid);
  return computeProcessIdentityVerdict(
    liveness,
    token.startIdentity,
    observedIdentity,
  );
}

// Mutable indirection for the start-time probe `verifyProcessIdentity` consults, defaulting to the real `readProcessStartTimeMs` below.
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

// Parses `ps -o etime=` output: `[[dd-]hh:]mm:ss`.
// Elapsed time (not a wall-clock date) sidesteps `ps`'s locale-dependent date formatting entirely - the alternative (`lstart`) would need locale-aware parsing.
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

// The readers below answer a narrower question - "which process instance is this?" - by fetching a stamp the kernel wrote once at process creation and never recomputes.
// So `lstart` is read under a pinned locale and timezone and compared AS text - never parsed into a timestamp, which would let a locale change or a tzdata update reintroduce the drift by the back door.

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

// The stored stamp has to format identically on every read, so the probe pins
// locale and timezone instead of inheriting the user's shell.
const DETERMINISTIC_FORMAT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  LC_ALL: "C",
  TZ: "UTC",
};

// A boot id cannot change within a boot, and a `/proc` that could not be read once (masked in a container, an exotic mount namespace) will not start working later - so both the value and the failure are cached.
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

// Field 22 of `/proc/<pid>/stat`.
// Field 2 is `comm` - the executable name in parentheses, which may itself contain spaces and ')' - so the only safe place to begin splitting is the last ')' in the record.
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
        }),
      );
    }
    return formatDarwinProcessStartIdentity(
      execFileSync("ps", darwinLstartArgs(pid), {
        encoding: "utf8",
        timeout: 3000,
        env: DETERMINISTIC_FORMAT_ENV,
      }),
    );
  } catch {
    // A dead pid, a denied probe, missing tooling: no token, and every caller
    // reads the absence as "cannot compare", never as evidence of anything.
    return null;
  }
}

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
      5_000,
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

export function readProcessStartIdentity(
  pid: number,
): ProcessStartIdentity | null {
  return readProcessStartIdentityImpl(pid);
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
      undefined,
    );
    if (stdout === null) return null;
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  for (
    let retry = 0;
    retry <= POSIX_PROCESS_START_TIME_MAX_RETRIES;
    retry += 1
  ) {
    const stdout = await execFileOutput(
      "ps",
      ["-p", String(pid), "-o", "etime="],
      3_000,
      undefined,
    );
    if (stdout === null) return null;
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

// Exported for tests so the fixed-format parser can be exercised directly
// without shelling out to `ps`.
export const __parseElapsedSecondsForTest = parseElapsedSeconds;
export const __processStartTimeMsFromElapsedSecondsForTest =
  processStartTimeMsFromElapsedSeconds;
