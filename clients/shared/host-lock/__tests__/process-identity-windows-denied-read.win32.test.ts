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
    // No `test.retry`/`hookTimeout` override in this project's vitest.config.ts
    // (clients/shared), so the effective outer budget is vitest's 5_000ms
    // default. Retained CI (cold review, 2026-09-29): 3 successful runs at
    // 3_224/4_123/2_849ms, all under 5_000; the branch-head run timed out at
    // 5_947ms. 85_000ms below is a conservative first-owned-child-route
    // ALLOCATION (a sum of configured subprocess timeout ALLOWANCES, not an
    // observed or expected elapsed time) - its headroom over the measured
    // runs is by design, not evidence that the route normally takes anywhere
    // near 85s.
    //
    // This budget is sized for ONE specific normal passing route - the
    // OWNED-CHILD route, where `spawnDeniedReadChild()` succeeds on its
    // first attempt (spawn a child, DACL-deny it, confirm the deny via WMI,
    // all in that one call). It is NOT sized for the FALLBACK-SCAN route:
    // `samplePrecondition`'s retry loop (up to `PRECONDITION_SAMPLE_ATTEMPTS`
    // = 3 attempts) and `findDeniedReadCandidate()`'s scan of already-running
    // processes are real, legitimate ways this test can ALSO pass (not only
    // failure recovery - a loaded runner where the owned-child DACL write
    // races something, or a machine where the scan finds a candidate faster,
    // both pass through this route too), and are deliberately left
    // unbudgeted here: each extra attempt adds up to 45_000ms
    // (spawnDeniedReadChild 30_000 + findDeniedReadCandidate 15_000), which
    // would push this test's real-worst-case well past any budget this file
    // can reasonably carry without evidence that the fallback route actually
    // fires often. If retained CI history ever shows this test routinely
    // taking the fallback/retry route, this budget needs revisiting to
    // include it explicitly rather than relying on the margin below to
    // absorb it.
    //
    // Owned-child route, sequential:
    //  - seDebugHeld(): execFileSync timeout 15_000.
    //  - spawnDeniedReadChild() (one attempt): execFileSync timeout 30_000.
    //  - Two matchLiveProcessStartIdentity() calls (production, in
    //    clients/shared/host-lock/process-identity.ts): each first tries
    //    processStartIdentityReader() (win32: execFileSync powershell,
    //    timeout 5_000), and - since the DACL-denied pid's exact read never
    //    succeeds - always falls through to windowsDeniedReadCreationReader()
    //    (execFileSync powershell, WINDOWS_START_IDENTITY_TIMEOUT_MS=5_000);
    //    2 * (5_000 + 5_000) = 20_000.
    //  - One readProcessStartIdentity() call: processStartIdentityReader()
    //    again, win32 execFileSync timeout 5_000.
    //  Total: 15_000 + 30_000 + 20_000 + 5_000 = 70_000ms.
    //  +15_000ms margin for process spawn/teardown overhead => 85_000ms. This
    //  margin is headroom for the owned-child route's own variance (spawn
    //  jitter, WMI query latency under load), not a claim that it also
    //  covers a fallback/retry pass.
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
    }, 85_000);
  },
);
