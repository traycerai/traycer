import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatWindowsProcessStartIdentity,
  parseWindowsWmiCreationDate,
} from "@traycer/protocol/host/lifecycle";
import {
  matchLiveProcessStartIdentity,
  readProcessStartIdentity,
} from "../process-identity";
import {
  PRECONDITION_SAMPLE_ATTEMPTS,
  samplePrecondition,
} from "../../test-fixtures/precondition-sample";

// The real thing, on a real Windows machine. Section A and the seam-based
// sibling prove the mechanism against a scripted `tasklist` / `powershell`;
// this file proves the SAME code path against a real process this security
// context genuinely cannot read exactly - its own DACL-denied child, or a
// session-0 service when the runner is unelevated.
//
// On an elevated token (the GitHub Windows runner's own) SeDebugPrivilege is
// held, and the reader's fresh PowerShell enables it during its own startup
// and reads everything - a DACL deny binds nothing, so there is no denied
// read left to find. So this file must run through `run-without-sedebug.ps1`,
// which removes the privilege from the token the whole run inherits; a
// removed privilege cannot be re-enabled by any descendant. The first test
// below checks that first: it fails under `CI` if the privilege is still
// held (naming the wrapper), and skips elsewhere with the same reason rather
// than asserting nothing.
//
// Read-only and additive: nothing here kills or spawns a tracked process -
// only `powershell` itself, to enumerate `Get-Process` and to answer
// `Get-WmiObject` for a pid this test never otherwise touches, plus its own
// node child and a `whoami`. This file only runs on Windows
// (`describe.skipIf` below) and is wired into the Windows CI job separately.

const FIND_DENIED_READ_PID_SCRIPT = [
  "foreach ($p in Get-Process) {",
  "  try {",
  "    $null = $p.get_StartTime()",
  "    continue",
  "  } catch {",
  "    $reason = $_.Exception",
  "    while ($null -ne $reason -and -not ($reason -is [System.ComponentModel.Win32Exception])) {",
  "      $reason = $reason.InnerException",
  "    }",
  "    if ($null -eq $reason -or $reason.NativeErrorCode -ne 5) { continue }",
  '    $row = Get-WmiObject Win32_Process -Filter "ProcessId = $($p.Id)"',
  "    if ($null -eq $row -or $null -eq $row.CreationDate) { continue }",
  '    "$($p.Id)|$([string]$row.CreationDate)"',
  "    break",
  "  }",
  "}",
].join("\n");

interface DeniedReadCandidate {
  readonly pid: number;
  readonly creationMicros: number;
}

type DeniedReadResult =
  | { readonly kind: "candidate"; readonly candidate: DeniedReadCandidate }
  | { readonly kind: "refused"; readonly exitCode: number | null };

// `execFileSync` throws an Error augmented with `status` (the child's exit
// code, or null on a timeout/signal) when the child exits non-zero.
function exitCodeOfError(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
}

// Whether this process's token holds SeDebugPrivilege, enabled or not.
// Every `powershell` the reader starts inherits the token, and a fresh
// PowerShell enables SeDebug during its own startup (measured on a Windows
// VM), so while the privilege is held a DACL deny binds nothing the reader
// does and no denied read exists to find. `whoami` inherits the same token;
// privilege names are not localised.
function seDebugHeld(): boolean {
  return execFileSync("whoami", ["/priv", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  }).includes('"SeDebugPrivilege"');
}

const SEDEBUG_HELD_REASON =
  "this token holds SeDebugPrivilege, so every PowerShell the reader starts can read every process - run this file through run-without-sedebug.ps1, as the Windows CI step does";

// Enumerates real, currently running processes and returns the first one
// whose exact `.get_StartTime()` read is refused with ERROR_ACCESS_DENIED
// (NativeErrorCode 5) and which WMI can still answer for - the unwrap logic
// mirrors `buildWindowsDeniedReadFallbackScript`'s own per-pid check, applied
// across every process instead of one.
function findDeniedReadCandidate(): DeniedReadCandidate | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        FIND_DENIED_READ_PID_SCRIPT,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
  } catch {
    return null;
  }
  const line = stdout.trim();
  if (line.length === 0) return null;
  const separator = line.indexOf("|");
  if (separator < 0) return null;
  const pid = Number(line.slice(0, separator));
  const creationMicros = parseWindowsWmiCreationDate(line.slice(separator + 1));
  return Number.isInteger(pid) && pid > 0 && creationMicros !== null
    ? { pid, creationMicros }
    : null;
}

const spawnedDeniedChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawnedDeniedChildren.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

function spawnDeniedReadChild(): DeniedReadResult {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    child.kill();
    return { kind: "refused", exitCode: null };
  }
  spawnedDeniedChildren.push(child);
  const scriptPath = fileURLToPath(
    new URL("./deny-process-query.ps1", import.meta.url),
  );
  let stdout: string;
  try {
    stdout = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-File", scriptPath, String(pid)],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
  } catch (error) {
    return { kind: "refused", exitCode: exitCodeOfError(error) };
  }
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .filter((entry) => entry.includes("|"))
    .pop();
  if (line === undefined) return { kind: "refused", exitCode: 0 };
  const separator = line.indexOf("|");
  if (separator < 0) return { kind: "refused", exitCode: 0 };
  const parsedPid = Number(line.slice(0, separator));
  const creationMicros = parseWindowsWmiCreationDate(line.slice(separator + 1));
  return Number.isInteger(parsedPid) && parsedPid > 0 && creationMicros !== null
    ? { kind: "candidate", candidate: { pid: parsedPid, creationMicros } }
    : { kind: "refused", exitCode: 0 };
}

// Exit-code legend for the DACL-deny child (`deny-process-query.ps1`): 2 =
// DenyQuery failed, 3 = StartTime still readable (the DACL did not bind),
// 4 = the read failed with a code other than 5, 5 = WMI has no
// CreationDate, null = the script could not run.
/**
 * PRECONDITION: establishes a real process this test can prove a denied
 * read against - the owned DACL-deny child first, then a scan of
 * already-running processes. Not itself the subject of an assertion; the
 * assertions below are about the production reader's behaviour against
 * whichever candidate this resolves to. Only a deny script that could not
 * run at all (a timeout or signal, `exitCode` null) is retried; a deny that
 * ran and refused is a fact about this machine, reported unretried with its
 * exit code.
 */
async function requireDeniedReadCandidate(): Promise<DeniedReadCandidate> {
  return samplePrecondition(
    "denied-read candidate (owned DACL-deny child or session-0 scan)",
    PRECONDITION_SAMPLE_ATTEMPTS,
    async () => {
      const owned = spawnDeniedReadChild();
      if (owned.kind === "candidate") return owned.candidate;
      const scanned = findDeniedReadCandidate();
      if (scanned !== null) return scanned;
      if (owned.exitCode !== null) {
        throw new Error(
          `neither the DACL-deny child (exit=${String(owned.exitCode)}) nor the session-0 scan produced a candidate, with SeDebugPrivilege not held`,
        );
      }
      return null;
    },
  );
}

// UTC epoch microseconds back to the round-trip ("o") ISO text a recorded
// Windows token carries - WMI only ever gives six fractional digits, so the
// 7th is synthetic and deliberately non-zero, exactly like a real .NET
// `DateTime.ToString("o")` on a FILETIME with a nonzero 100ns remainder.
function isoFromUtcMicros(utcMicros: number, seventhDigit: string): string {
  const wholeSeconds = Math.floor(utcMicros / 1_000_000);
  const microsWithinSecond = utcMicros - wholeSeconds * 1_000_000;
  const dateIso = new Date(wholeSeconds * 1000).toISOString();
  const isoPrefix = dateIso.slice(0, dateIso.indexOf("."));
  const sixDigits = String(microsWithinSecond).padStart(6, "0");
  return `${isoPrefix}.${sixDigits}${seventhDigit}Z`;
}

function tokenFromUtcMicros(utcMicros: number, seventhDigit: string): string {
  const token = formatWindowsProcessStartIdentity(
    isoFromUtcMicros(utcMicros, seventhDigit),
  );
  if (token === null) {
    throw new Error("fixture Windows token failed to format");
  }
  return token;
}

describe.skipIf(process.platform !== "win32")(
  "matchLiveProcessStartIdentity: a real denied read on this Windows machine",
  () => {
    it("resolves a real inaccessible process through WMI, and the exact reader stays primary-only", async (ctx) => {
      const held = seDebugHeld();
      if (held && process.env.CI) throw new Error(SEDEBUG_HELD_REASON);
      ctx.skip(held, SEDEBUG_HELD_REASON);
      if (held) return;
      const candidate = await requireDeniedReadCandidate();

      const recordedToken = tokenFromUtcMicros(candidate.creationMicros, "5");
      expect(matchLiveProcessStartIdentity(candidate.pid, recordedToken)).toBe(
        "same",
      );

      const movedToken = tokenFromUtcMicros(candidate.creationMicros + 2, "5");
      expect(matchLiveProcessStartIdentity(candidate.pid, movedToken)).toBe(
        "different",
      );

      // The RECORDING read stays exact-only even now - a denied read must
      // never be recorded as a token, or a WMI creation time would compare
      // as `different` against every later exact read of the same process.
      expect(readProcessStartIdentity(candidate.pid)).toBeNull();
    });
  },
);
