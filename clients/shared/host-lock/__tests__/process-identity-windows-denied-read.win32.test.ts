import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  formatWindowsProcessStartIdentity,
  parseWindowsWmiCreationDate,
} from "@traycer/protocol/host/lifecycle";
import {
  matchLiveProcessStartIdentity,
  readProcessStartIdentity,
} from "../process-identity";

// The real thing, on a real Windows machine. Section A and the seam-based
// sibling prove the mechanism against a scripted `tasklist` / `powershell`;
// this file proves the SAME code path against a real process this security
// context genuinely cannot read exactly - a session-0 service when the
// runner is unelevated. An ELEVATED runner can read everything, so there is
// no candidate to find; the one test below self-skips at runtime rather than
// asserting nothing.
//
// Read-only and additive: nothing here kills or spawns a tracked process -
// only `powershell` itself, to enumerate `Get-Process` and to answer
// `Get-WmiObject` for a pid this test never otherwise touches. This file only
// runs on Windows (`describe.skipIf` below) and is wired into the Windows CI
// job separately.

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
    it("resolves a real inaccessible process through WMI, and the exact reader stays primary-only", (ctx) => {
      const candidate = findDeniedReadCandidate();
      ctx.skip(
        candidate === null,
        "no process in this security context has a denied exact read (an elevated runner can read everything) - nothing to prove here",
      );
      if (candidate === null) return;

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
