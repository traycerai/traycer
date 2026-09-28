import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";
import type {
  HelperArmWaitDeps,
  SpawnImpl,
  SpawnedProcess,
} from "../finalize-helper";

// The real Windows handoff. The seam-based finalize-helper tests prove the
// launcher's and guard's SHAPE against a stub; this file proves that a real
// `powershell.exe` launcher actually starts the helper script, that the
// script's arm guard - `IsProcessInJob` checked before the sentinel write,
// through the stable `# END ARM GUARD` anchor - actually arms it, and that
// an armed helper survives the exit of the process that launched it. Arming
// is NOT simply "the first line ran": the guard only writes `.armed` once it
// has confirmed the process is no longer a job member, and writes
// `.not-armed` (with a fixed reason: "in-job" or "job-check-failed")
// otherwise. That distinction, and the job-object behaviour the module doc
// comment leans on (CREATE_BREAKAWAY_FROM_JOB, double-checked via
// IsProcessInJob rather than trusted on its own - the freeze-9 fix), can
// only be shown by a real Windows process tree.
//
// Because arming now depends on whether THIS runner's own process tree lets
// breakaway succeed, several tests here branch on the actual observed
// outcome (armed vs refused) instead of assuming success - a CI runner can
// itself sit inside a job whose policy denies CREATE_BREAKAWAY_FROM_JOB, in
// which case refusing to arm is the correct, safe behaviour and the only
// one these tests should accept. Each such branch is logged via
// `process.stdout.write` rather than silently skipped, so CI output always
// shows which path actually ran.
//
// A plain, unbroken-away child of THIS test process (e.g. a bare
// `spawnSync("powershell.exe", ...)`) is a job member unconditionally
// (libuv's own KILL_ON_JOB_CLOSE job), which would make the arm guard
// refuse for reasons that have nothing to do with what a given test
// exercises. Tests that need a script to actually reach its post-arm
// behaviour launch it through `runScriptWithBreakaway` (a minimal
// CreateProcessW + CREATE_BREAKAWAY_FROM_JOB launch) instead.
//
// The helper here runs a marker-only tail - the production arm guard (BOM
// through `# END ARM GUARD`), then a sleep and a `.survived` file - so
// nothing finalizes or touches the install. The abandoned-helper case runs
// the whole production script, against a `.cmd` stub instead of the staged
// binary.
//
// `store/paths` binds its home root from `os.homedir()` at module load, and
// scheduling unlinks the post-finalize marker and creates the CLI home dir,
// so every test redirects the home first and imports the modules after it
// (dynamically, behind `vi.resetModules()`). Nothing here touches a real home.
//
// This file only runs on Windows (`describe.skipIf` below) and is wired into
// the `test-windows-cli-exit` job in `.github/workflows/test.yml`.

// `homedir()` is redirected; `tmpdir()` follows the real TEMP/TMP variables.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

// Vitest's default is 5 s; these cases wait on a real PowerShell start (arm
// wait up to 10 s), an 8 s helper tail, a 20 s poll and 30 s spawnSync limits.
const TEST_TIMEOUT_MS = 60_000;

// The marker-only helper's post-arm tail keeps it alive this long before it
// writes `.survived` and exits. Some callers (`assertArmedOrRefused`) open
// the armed helper's real pid with a cold PowerShell probe process after
// arming is observed - Add-Type's JIT/type-load cost on a loaded CI box can
// itself take a couple of seconds, so this needs real margin rather than
// "just long enough for the happy path": a probe that starts after the
// helper has already exited would misreport, or throw, for reasons that
// have nothing to do with what's under test.
const HELPER_SLEEP_SECONDS = 8;
const SURVIVED_POLL_MS = 20_000;

const ORIGINAL_TEMP = process.env.TEMP;
const ORIGINAL_TMP = process.env.TMP;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workRoot: string;
let workHome: string;

async function loadHelper() {
  return await import("../finalize-helper");
}

const helperPids: number[] = [];

function restoreEnv(
  name: "TEMP" | "TMP" | "HOME" | "USERPROFILE",
  original: string | undefined,
): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function pointTempAt(dir: string): void {
  process.env.TEMP = dir;
  process.env.TMP = dir;
}

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), "traycer-finalize-launch-test-"));
  pointTempAt(workRoot);
  workHome = join(workRoot, "home");
  mkdirSync(workHome, { recursive: true });
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  for (const pid of helperPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  restoreEnv("TEMP", ORIGINAL_TEMP);
  restoreEnv("TMP", ORIGINAL_TMP);
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("USERPROFILE", ORIGINAL_USERPROFILE);
  osHome.current = "";
  rmSync(workRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
});

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return existsSync(path);
}

// The production script's arm guard - everything through the sentinel line
// gated on IsProcessInJob (see `# END ARM GUARD`, the stable anchor the
// generated script leaves for tests) - up front, then a tail that only
// leaves a marker three seconds later. Extracting the WHOLE guard, not just
// a first line, matters now: arming is conditional on the job check, so a
// test tail spliced in after only the unconditional first line would run
// even when the production script itself would have refused to arm.
function extractArmGuard(productionBody: string): string {
  const anchor = "# END ARM GUARD";
  const idx = productionBody.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      `finalize helper script is missing the ${anchor} anchor - update extractArmGuard if the guard's shape changed`,
    );
  }
  return productionBody.slice(0, idx + anchor.length);
}

function markerOnlyScript(
  productionBody: string,
  survivedPath: string,
): string {
  const guard = extractArmGuard(productionBody);
  return [
    guard,
    `Start-Sleep -Seconds ${HELPER_SLEEP_SECONDS}`,
    `[System.IO.File]::WriteAllText(${powershellSingleQuoted(survivedPath)}, 'ok')`,
    "",
  ].join("\n");
}

// The production arm guard, then a wait (bounded, 60 s) for `goPath`, then
// a marker holding the helper's own pid. The marker can therefore only be
// written once the test creates `goPath`, after the launching process is gone.
function handshakeScript(
  productionBody: string,
  goPath: string,
  survivedPath: string,
): string {
  const guard = extractArmGuard(productionBody);
  return [
    guard,
    "$d = (Get-Date).AddSeconds(60)",
    `while (-not (Test-Path -LiteralPath ${powershellSingleQuoted(goPath)}) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 100 }`,
    `[System.IO.File]::WriteAllText(${powershellSingleQuoted(survivedPath)}, [string]$PID)`,
    "",
  ].join("\n");
}

const NEVER_EXITS: SpawnedProcess["exited"] = new Promise(() => undefined);

function fastClock(): HelperArmWaitDeps {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    waitMs: 1_000,
    pollIntervalMs: 100,
  };
}

interface RecordedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly detached: boolean | undefined;
  readonly stdio: unknown;
  readonly windowsHide: boolean | undefined;
}

// Whether an EXTERNAL, already-running process (by pid) is currently
// inside a job - opened and queried for real via the same IsProcessInJob
// the production helper's arm guard uses. Probing the CURRENT test
// process is a trap here: it's spawned via Node/libuv, which puts any
// non-detached child (a Windows PowerShell probe included) into its own
// job (SILENT_BREAKAWAY_OK) regardless of whether the ambient runner
// itself is confined, so a pre-flight self-probe reports "in a job" almost
// unconditionally and gives a tautological branch. Verifying the ACTUAL
// helper pid the module armed, from a wholly separate probe process, is
// the only check that isn't circular with the module's own self-report.
function probeIsProcessInJob(pid: number): boolean {
  const probe = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class TraycerJobProbe {",
    "  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result);",
    '  [DllImport("kernel32.dll")]',
    "  public static extern bool CloseHandle(IntPtr h);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig -ErrorAction Stop",
    `$h = [TraycerJobProbe]::OpenProcess([TraycerJobProbe]::PROCESS_QUERY_LIMITED_INFORMATION, $false, ${pid})`,
    "if ($h -eq [IntPtr]::Zero) { Write-Output 'OPEN_FAILED'; exit 1 }",
    "$result = $false",
    "$ok = [TraycerJobProbe]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$result)",
    "[void][TraycerJobProbe]::CloseHandle($h)",
    "if (-not $ok) { Write-Output 'QUERY_FAILED'; exit 1 }",
    "Write-Output $result",
  ].join("\n");
  const run = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      probe,
    ],
    { timeout: 15_000 },
  );
  const stdout = (run.stdout ?? "").toString().trim();
  // Anything other than an exact, successful True/False is a probe failure,
  // not a "false" answer - conflating the two would let an API error read
  // as "not in a job" and silently pass a check whose whole point is to
  // catch exactly that kind of false confidence.
  if (run.status !== 0 || (stdout !== "True" && stdout !== "False")) {
    throw new Error(
      `probeIsProcessInJob: probe for pid ${pid} did not return a clean True/False (status=${run.status}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify((run.stderr ?? "").toString())})`,
    );
  }
  return stdout === "True";
}

interface ArmResultLike {
  readonly status: "armed" | "skipped" | "failed";
  readonly armedPath: string | null;
  readonly helperPid: number | null;
}

// Branches on the ACTUAL scheduled outcome, not a prediction: armed is
// verified by asking the OS about the real helper pid (see
// `probeIsProcessInJob` above for why a pre-flight guess would be
// tautological); refused is verified by the fixed `.not-armed` sentinel
// and the absence of `.armed`. Both are correct outcomes depending on
// whether this run's breakaway actually succeeded - what must never
// happen is an armed helper that is STILL job-confined, which is exactly
// what freeze 9 was.
function assertArmedOrRefused(result: ArmResultLike): void {
  if (result.status === "armed") {
    process.stdout.write(
      `[finalize-helper launch test] branch: armed (helperPid=${result.helperPid})\n`,
    );
    expect(typeof result.helperPid).toBe("number");
    expect(existsSync(result.armedPath ?? "")).toBe(true);
    if (result.helperPid !== null) {
      helperPids.push(result.helperPid);
      expect(probeIsProcessInJob(result.helperPid)).toBe(false);
    }
    return;
  }
  expect(result.status).toBe("failed");
  const notArmedPath = (result.armedPath ?? "").replace(
    /\.armed$/,
    ".not-armed",
  );
  const reason = existsSync(notArmedPath)
    ? readFileSync(notArmedPath, "utf8")
    : "(no .not-armed file found)";
  process.stdout.write(
    `[finalize-helper launch test] branch: refused (reason=${reason})\n`,
  );
  expect(existsSync(notArmedPath)).toBe(true);
  expect(existsSync(result.armedPath ?? "")).toBe(false);
}

// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway bits.
const KILL_ON_JOB_CLOSE_NO_BREAKAWAY = 0x2000;

// Prefix the driver writes to stdout ahead of any harness-side failure
// (an API call that returned FALSE), so the test can tell "the harness
// itself couldn't confine the process" apart from "it confined the
// process and the guard correctly refused to arm" - conflating those
// would let a broken harness pass by accident.
const HARNESS_ERROR_PREFIX = "HARNESS_ERROR:";

// Runs the production arm guard (the whole `# END ARM GUARD` block,
// extracted the same way the marker-only/handshake scripts above do)
// inside a *separately constructed* job object that sets
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE without either breakaway bit - the
// control the module doc comment's fix leans on: a job whose policy never
// grants the break, so CREATE_BREAKAWAY_FROM_JOB either fails outright or
// (as in the freeze-9 report) the child still lands inside it. This
// confines the guard directly rather than going through the launcher's own
// CreateProcessW, so the assertion is about the GUARD's own runtime check,
// independent of whichever way the launcher's breakaway attempt failed.
//
// The child is created SUSPENDED and assigned to the confining job BEFORE
// its main thread ever runs - Start-Process, then AssignProcessToJobObject
// on the already-running process, has a window where the child can reach
// its IsProcessInJob check before the assignment lands, which would let
// the control silently pass for the wrong reason (or flake). Every Win32
// call's return value is checked; a failure is reported as
// `HARNESS_ERROR:<step> (Win32 error <code>)` on stdout rather than left to
// surface as a confusing exit code.
//
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` lives in
// `JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags`, but `SetInformationJobObject`
// only accepts that struct wrapped in the EXTENDED one
// (`JobObjectExtendedLimitInformation`, info class 9) - passing the bare
// basic struct with info class 2 (`JobObjectBasicLimitInformation`, which
// does not honour LimitFlags for this purpose) is rejected by the API.
//
// `commandLine` is the FULL Win32 command line (already quoted the way
// CreateProcessW expects - a leading `powershell.exe ...` or the exact
// argv0 + args of a recorded real launch), so this same driver can confine
// either the guard script directly or the production launcher itself.
//
// `watchPath` is the `.not-armed` path the confined side is expected to
// write. The job object is KILL_ON_JOB_CLOSE, and its last handle closes
// implicitly when THIS driver process exits - if the confined command's own
// CreateProcessW somehow still produced a job-member helper (the exact
// freeze-9 phenomenon: breakaway can silently fail to fully take even when
// the OS call itself reports success), that helper is a process the driver
// never directly waits on, and closing the job out from under it could kill
// it before its guard finishes writing `.not-armed`. So after the confined
// process/launcher itself exits, the driver additionally polls for
// `watchPath` (bounded ~5 s) before letting its own process - and so the
// job handle - go away.
//
// `useBrokenNestedValueTypeAssignment` is TEST-ONLY, off by default: it
// deliberately reproduces the nested-value-type bug this driver's own
// `$basic = ...; $basic.LimitFlags = ...; $info.BasicLimitInformation =
// $basic` copy-out/copy-in dance exists to avoid (assigning straight into
// `.BasicLimitInformation.LimitFlags` mutates a COPY PowerShell handed
// back, leaving `$info` itself untouched, so the job that gets created has
// LimitFlags=0 - no KILL_ON_JOB_CLOSE at all - while looking, to anything
// that doesn't read it back, like it worked). It exists so a negative
// control can prove the read-back gate below actually catches that
// specific failure, not just any failure.
function runCommandUnderNoBreakawayJob(
  commandLine: string,
  watchPath: string,
  opts: { readonly useBrokenNestedValueTypeAssignment: boolean },
): {
  readonly exitCode: number | null;
  readonly harnessError: string | null;
} {
  const driver = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class TraycerJobHarness {",
    "  public const int JobObjectExtendedLimitInformation = 9;",
    "  public const uint CREATE_SUSPENDED = 0x00000004;",
    "  public const uint INFINITE = 0xFFFFFFFF;",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {",
    "    public long PerProcessUserTimeLimit;",
    "    public long PerJobUserTimeLimit;",
    "    public uint LimitFlags;",
    "    public UIntPtr MinimumWorkingSetSize;",
    "    public UIntPtr MaximumWorkingSetSize;",
    "    public uint ActiveProcessLimit;",
    "    public UIntPtr Affinity;",
    "    public uint PriorityClass;",
    "    public uint SchedulingClass;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct IO_COUNTERS {",
    "    public ulong ReadOperationCount;",
    "    public ulong WriteOperationCount;",
    "    public ulong OtherOperationCount;",
    "    public ulong ReadTransferCount;",
    "    public ulong WriteTransferCount;",
    "    public ulong OtherTransferCount;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {",
    "    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;",
    "    public IO_COUNTERS IoInfo;",
    "    public UIntPtr ProcessMemoryLimit;",
    "    public UIntPtr JobMemoryLimit;",
    "    public UIntPtr PeakProcessMemoryUsed;",
    "    public UIntPtr PeakJobMemoryUsed;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct STARTUPINFO {",
    "    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;",
    "    public int dwX; public int dwY; public int dwXSize; public int dwYSize;",
    "    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;",
    "    public int dwFlags; public short wShowWindow; public short cbReserved2;",
    "    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct PROCESS_INFORMATION {",
    "    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;",
    "  }",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern IntPtr CreateJobObject(IntPtr a, string lpName);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength, out uint lpReturnLength);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);",
    '  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", ExactSpelling=true, SetLastError=true, CharSet=CharSet.Unicode)]',
    "  public static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);",
    // Wraps CreateProcessW and its GetLastWin32Error() capture in ONE
    // compiled method: confirmed on a Windows PowerShell 5.1 VM that
    // querying [Marshal]::GetLastWin32Error() from PowerShell AFTER the
    // P/Invoke returns reads a CLOBBERED value (the interpreter's own
    // intervening calls reset the thread's last-error slot before the
    // script gets to read it). Capturing it here, with no PowerShell
    // frames between the native call and the read, is the only reliable
    // way to see the real code (e.g. 5 / ACCESS_DENIED).
    "  public static bool TryCreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation, out int lastError) {",
    "    bool ok = CreateProcessW(lpApplicationName, lpCommandLine, lpProcessAttributes, lpThreadAttributes, bInheritHandles, dwCreationFlags, lpEnvironment, lpCurrentDirectory, ref lpStartupInfo, out lpProcessInformation);",
    "    lastError = ok ? 0 : Marshal.GetLastWin32Error();",
    "    return ok;",
    "  }",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern uint ResumeThread(IntPtr hThread);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool CloseHandle(IntPtr hObject);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig -ErrorAction Stop",
    // `Fail` is for the OTHER API calls, where PowerShell's own
    // [Marshal]::GetLastWin32Error() is the only source available -
    // CreateProcessW's error is instead captured natively (see
    // `TryCreateProcessW` above) and reported inline at its call site.
    "function Fail($step) {",
    "  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    `  Write-Output "${HARNESS_ERROR_PREFIX}$step (Win32 error $code)"`,
    "  exit 1",
    "}",
    "$job = [TraycerJobHarness]::CreateJobObject([IntPtr]::Zero, $null)",
    'if ($job -eq [IntPtr]::Zero) { Fail("CreateJobObject") }',
    "$info = New-Object TraycerJobHarness+JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
    ...(opts.useBrokenNestedValueTypeAssignment
      ? [
          // DELIBERATELY BROKEN, test-only: mutates a COPY of the nested
          // value type PowerShell handed back, never reaching `$info`
          // itself. See the function doc comment for why this exists.
          `$info.BasicLimitInformation.LimitFlags = [uint32]${KILL_ON_JOB_CLOSE_NO_BREAKAWAY}`,
        ]
      : [
          // `$info.BasicLimitInformation` is a nested VALUE TYPE -
          // PowerShell's property access returns a copy, so assigning into
          // `.BasicLimitInformation.LimitFlags` directly mutates that
          // copy, not the field inside `$info`. Round-trip through a
          // local variable.
          "$basic = $info.BasicLimitInformation",
          `$basic.LimitFlags = [uint32]${KILL_ON_JOB_CLOSE_NO_BREAKAWAY}`,
          "$info.BasicLimitInformation = $basic",
        ]),
    "$size = [System.Runtime.InteropServices.Marshal]::SizeOf($info)",
    "if (-not [TraycerJobHarness]::SetInformationJobObject($job, [TraycerJobHarness]::JobObjectExtendedLimitInformation, [ref]$info, [uint32]$size)) {",
    '  Fail("SetInformationJobObject")',
    "}",
    // Read the policy back from the OS rather than trusting the SET call's
    // own success - `SetInformationJobObject` returning TRUE only means the
    // API accepted the call, not that the flags we THINK we sent are the
    // flags that landed (the nested-value-type bug above is exactly a case
    // where they silently aren't). This must run BEFORE the confined child
    // is ever created: a job that isn't actually KILL_ON_JOB_CLOSE-only
    // would make this whole control meaningless without anyone noticing.
    "$readBack = New-Object TraycerJobHarness+JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
    "$readBackSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($readBack)",
    "[uint32]$returnedLength = 0",
    "if (-not [TraycerJobHarness]::QueryInformationJobObject($job, [TraycerJobHarness]::JobObjectExtendedLimitInformation, [ref]$readBack, $readBackSize, [ref]$returnedLength)) {",
    '  Fail("QueryInformationJobObject")',
    "}",
    `if ($readBack.BasicLimitInformation.LimitFlags -ne [uint32]${KILL_ON_JOB_CLOSE_NO_BREAKAWAY}) {`,
    '  $actualHex = "{0:X}" -f $readBack.BasicLimitInformation.LimitFlags',
    `  Write-Output "${HARNESS_ERROR_PREFIX}JobPolicyVerificationFailed (expected 0x${KILL_ON_JOB_CLOSE_NO_BREAKAWAY.toString(16)}, read back 0x$actualHex)"`,
    "  exit 1",
    "}",
    "$si = New-Object TraycerJobHarness+STARTUPINFO",
    "$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)",
    `$cmd = New-Object System.Text.StringBuilder(${powershellSingleQuoted(commandLine)})`,
    "$pi = New-Object TraycerJobHarness+PROCESS_INFORMATION",
    "$createLastError = 0",
    "if (-not [TraycerJobHarness]::TryCreateProcessW($null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, [TraycerJobHarness]::CREATE_SUSPENDED, [IntPtr]::Zero, $null, [ref]$si, [ref]$pi, [ref]$createLastError)) {",
    `  Write-Output "${HARNESS_ERROR_PREFIX}CreateProcessW (Win32 error $createLastError)"`,
    "  exit 1",
    "}",
    "if (-not [TraycerJobHarness]::AssignProcessToJobObject($job, $pi.hProcess)) {",
    '  Fail("AssignProcessToJobObject")',
    "}",
    "[uint32]$resumeResult = [TraycerJobHarness]::ResumeThread($pi.hThread)",
    "if ($resumeResult -eq [uint32]::MaxValue) {",
    '  Fail("ResumeThread")',
    "}",
    "$waitResult = [TraycerJobHarness]::WaitForSingleObject($pi.hProcess, 30000)",
    "if ($waitResult -ne 0) {",
    '  Fail("WaitForSingleObject (not WAIT_OBJECT_0)")',
    "}",
    "[uint32]$exitCode = 0",
    "if (-not [TraycerJobHarness]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode)) {",
    '  Fail("GetExitCodeProcess")',
    "}",
    "[void][TraycerJobHarness]::CloseHandle($pi.hThread)",
    "[void][TraycerJobHarness]::CloseHandle($pi.hProcess)",
    // The confined process/launcher has exited, but IF it still managed to
    // leave behind a job-member helper (see the function doc comment),
    // that helper is a process we never directly waited on. Give it a
    // bounded window to finish writing `.not-armed` before this driver
    // process ends and its KILL_ON_JOB_CLOSE job handle closes under it.
    `$deadline = (Get-Date).AddSeconds(5)`,
    `while (-not (Test-Path -LiteralPath ${powershellSingleQuoted(watchPath)}) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }`,
    "Write-Output $exitCode",
  ].join("\n");
  const run = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      driver,
    ],
    { timeout: 40_000 },
  );
  const stdout = (run.stdout ?? "").toString().trim();
  if (stdout.startsWith(HARNESS_ERROR_PREFIX)) {
    return { exitCode: null, harnessError: stdout };
  }
  const parsed = Number.parseInt(stdout, 10);
  return {
    exitCode: Number.isSafeInteger(parsed) ? parsed : null,
    harnessError: null,
  };
}

// Confines the production GUARD script (not the launcher) directly.
function runGuardUnderNoBreakawayJob(
  guardScriptPath: string,
  notArmedPath: string,
  opts: { readonly useBrokenNestedValueTypeAssignment: boolean },
): {
  readonly exitCode: number | null;
  readonly harnessError: string | null;
} {
  return runCommandUnderNoBreakawayJob(
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${guardScriptPath}"`,
    notArmedPath,
    opts,
  );
}

// Launches a script via CreateProcessW with CREATE_BREAKAWAY_FROM_JOB |
// CREATE_NO_WINDOW - the same escape the production launcher performs -
// and waits for it to exit. Plain `spawnSync("powershell.exe", [...])` is
// NOT equivalent here: a direct child of THIS test process is added to
// libuv's own KILL_ON_JOB_CLOSE job (no breakaway requested), so the new
// arm guard's IsProcessInJob check would always see itself job-confined
// and always refuse - not because of anything under test, but because of
// how the test happened to invoke it. Tests that need the script to
// actually arm (to exercise behaviour that only runs AFTER arming, such as
// the abandoned-marker check) launch it through here instead.
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_NO_WINDOW = 0x08000000;
function runScriptWithBreakaway(scriptPath: string): {
  readonly exitCode: number | null;
  readonly harnessError: string | null;
} {
  const commandLine = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const driver = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class TraycerBreakawayLauncher {",
    `  public const uint CREATE_BREAKAWAY_FROM_JOB = ${CREATE_BREAKAWAY_FROM_JOB};`,
    `  public const uint CREATE_NO_WINDOW = ${CREATE_NO_WINDOW};`,
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct STARTUPINFO {",
    "    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;",
    "    public int dwX; public int dwY; public int dwXSize; public int dwYSize;",
    "    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;",
    "    public int dwFlags; public short wShowWindow; public short cbReserved2;",
    "    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct PROCESS_INFORMATION {",
    "    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;",
    "  }",
    '  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", ExactSpelling=true, SetLastError=true, CharSet=CharSet.Unicode)]',
    "  public static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);",
    // Same native-capture wrapper as `runCommandUnderNoBreakawayJob`'s
    // TraycerJobHarness - PowerShell re-querying [Marshal]::GetLastWin32Error()
    // after the P/Invoke returns reads a clobbered value on PS5.1, so
    // `isBreakawayAccessDenied` (which keys off Win32 error 5) needs the
    // real code captured here instead.
    "  public static bool TryCreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation, out int lastError) {",
    "    bool ok = CreateProcessW(lpApplicationName, lpCommandLine, lpProcessAttributes, lpThreadAttributes, bInheritHandles, dwCreationFlags, lpEnvironment, lpCurrentDirectory, ref lpStartupInfo, out lpProcessInformation);",
    "    lastError = ok ? 0 : Marshal.GetLastWin32Error();",
    "    return ok;",
    "  }",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);",
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    "  public static extern bool CloseHandle(IntPtr hObject);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig -ErrorAction Stop",
    "function Fail($step) {",
    "  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    `  Write-Output "${HARNESS_ERROR_PREFIX}$step (Win32 error $code)"`,
    "  exit 1",
    "}",
    "$si = New-Object TraycerBreakawayLauncher+STARTUPINFO",
    "$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)",
    `$cmd = New-Object System.Text.StringBuilder(${powershellSingleQuoted(commandLine)})`,
    "$pi = New-Object TraycerBreakawayLauncher+PROCESS_INFORMATION",
    "$flags = [TraycerBreakawayLauncher]::CREATE_BREAKAWAY_FROM_JOB -bor [TraycerBreakawayLauncher]::CREATE_NO_WINDOW",
    "$createLastError = 0",
    "if (-not [TraycerBreakawayLauncher]::TryCreateProcessW($null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, [IntPtr]::Zero, $null, [ref]$si, [ref]$pi, [ref]$createLastError)) {",
    `  Write-Output "${HARNESS_ERROR_PREFIX}CreateProcessW (Win32 error $createLastError)"`,
    "  exit 1",
    "}",
    "$waitResult = [TraycerBreakawayLauncher]::WaitForSingleObject($pi.hProcess, 30000)",
    "if ($waitResult -ne 0) {",
    '  Fail("WaitForSingleObject (not WAIT_OBJECT_0)")',
    "}",
    "[uint32]$exitCode = 0",
    "if (-not [TraycerBreakawayLauncher]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode)) {",
    '  Fail("GetExitCodeProcess")',
    "}",
    "[void][TraycerBreakawayLauncher]::CloseHandle($pi.hThread)",
    "[void][TraycerBreakawayLauncher]::CloseHandle($pi.hProcess)",
    "Write-Output $exitCode",
  ].join("\n");
  const run = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      driver,
    ],
    { timeout: 40_000 },
  );
  const stdout = (run.stdout ?? "").toString().trim();
  if (stdout.startsWith(HARNESS_ERROR_PREFIX)) {
    return { exitCode: null, harnessError: stdout };
  }
  const parsed = Number.parseInt(stdout, 10);
  return {
    exitCode: Number.isSafeInteger(parsed) ? parsed : null,
    harnessError: null,
  };
}

// A recorded `SpawnImpl` call's argv, quoted into ONE Win32 command line the
// way CreateProcessW's `lpCommandLine` expects: each argument double-quoted,
// with the MSVCRT backslash/quote escaping rules a real process would need
// (a run of backslashes doubles only when it precedes a `"`, and any literal
// `"` is escaped). `command` is assumed unquoted-safe (always "powershell.exe"
// here - no spaces, no quoting needed).
function buildWin32CommandLine(
  command: string,
  args: readonly string[],
): string {
  const quoteArg = (arg: string): string => {
    if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
    let result = '"';
    let backslashes = 0;
    for (const ch of arg) {
      if (ch === "\\") {
        backslashes += 1;
        continue;
      }
      if (ch === '"') {
        result += "\\".repeat(backslashes * 2 + 1) + '"';
        backslashes = 0;
        continue;
      }
      result += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
    result += "\\".repeat(backslashes * 2) + '"';
    return result;
  };
  return [command, ...args.map(quoteArg)].join(" ");
}

describe.skipIf(process.platform !== "win32")(
  "the finalize helper's real PowerShell handoff",
  () => {
    it(
      "arms through the real launcher from a temp directory with an apostrophe and non-ASCII characters (or refuses, verified either way against this runner's actual job state)",
      async () => {
        const oddDir = join(workRoot, "O'Brien-Zoë-日本");
        mkdirSync(oddDir, { recursive: true });
        pointTempAt(oddDir);
        const {
          scheduleFinalizationHelper,
          defaultSpawnImpl,
          defaultWriteImpl,
          defaultHelperArmWaitDeps,
        } = await loadHelper();
        let survivedPath = "";
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(oddDir, "staged.exe"),
          livePath: join(oddDir, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: defaultSpawnImpl,
          writeImpl: async (path, body) => {
            if (!path.endsWith(".ps1")) {
              await defaultWriteImpl(path, body);
              return;
            }
            survivedPath = path.replace(/\.ps1$/, ".survived");
            await defaultWriteImpl(path, markerOnlyScript(body, survivedPath));
          },
          armWait: defaultHelperArmWaitDeps,
        });

        assertArmedOrRefused(result);
        if (result.status !== "armed") return;
        // The launcher has exited by now; the helper it started has not.
        expect(() => process.kill(result.helperPid ?? 0, 0)).not.toThrow();
        expect(await waitForFile(survivedPath, SURVIVED_POLL_MS)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "keeps running after the process that launched it exits",
      async () => {
        const recorded: RecordedLaunch[] = [];
        const recordingSpawn: SpawnImpl = (command, args, options) => {
          recorded.push({
            command,
            args,
            detached: options.detached,
            stdio: options.stdio,
            windowsHide: options.windowsHide,
          });
          return {
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: Promise.resolve({ exitCode: 0, errorMessage: null }),
          };
        };
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        let goPath = "";
        let survivedPath = "";
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(workRoot, "staged.exe"),
          livePath: join(workRoot, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: recordingSpawn,
          writeImpl: async (path, body) => {
            if (!path.endsWith(".ps1")) {
              await defaultWriteImpl(path, body);
              return;
            }
            goPath = path.replace(/\.ps1$/, ".go");
            survivedPath = path.replace(/\.ps1$/, ".survived");
            await defaultWriteImpl(
              path,
              handshakeScript(body, goPath, survivedPath),
            );
          },
          armWait: fastClock(),
        });
        // Nothing was launched, so the CLI side gave up; the script it wrote
        // is what the separate process below launches.
        expect(result.status).toBe("failed");
        expect(recorded).toHaveLength(1);

        // A separate node process plays the CLI: it spawns the recorded
        // launcher the way libuv does for the CLI (non-detached, so in its
        // job object), waits for the launcher, and exits.
        const parentScript = [
          'const { spawn } = require("node:child_process");',
          "const d = JSON.parse(process.env.LAUNCH_DESCRIPTOR);",
          "const child = spawn(d.command, d.args, {",
          "  stdio: d.stdio, windowsHide: d.windowsHide, detached: d.detached,",
          "});",
          'child.on("error", () => process.exit(4));',
          'child.on("exit", (code) => process.exit(code === 0 ? 0 : 3));',
        ].join("\n");
        const parent = spawnSync(process.execPath, ["-e", parentScript], {
          env: {
            ...process.env,
            LAUNCH_DESCRIPTOR: JSON.stringify(recorded[0]),
          },
          timeout: 30_000,
        });

        // The parent and its launcher are gone. Whether the helper armed
        // depends on whether ITS breakaway actually escaped whatever job this
        // runner's own process tree sits in (the launcher was itself a direct,
        // non-broken-away child of the throwaway node parent above, so it's
        // exactly as job-exposed as the production launcher would be) - branch
        // on the real outcome rather than assuming success.
        const armedPath = result.armedPath ?? "";
        const notArmedPath = armedPath.replace(/\.armed$/, ".not-armed");

        // `parentScript` maps ANY non-zero launcher exit code to 3. A launcher
        // whose own CreateProcess breakaway was denied exits 1 (see the
        // production launcher's `if (-not $created)` branch), which lands
        // here as exit 3 - checking `parent.status === 0` unconditionally,
        // before ever looking at `.not-armed`, would fail the test on exactly
        // the runner state (a job policy that denies breakaway) this branch
        // exists to accept safely.
        if (parent.status === 3) {
          process.stdout.write(
            "[finalize-helper launch test] branch: launcher's own CreateProcess breakaway denied - asserting safe refusal\n",
          );
          expect(existsSync(notArmedPath)).toBe(true);
          const reason = readFileSync(notArmedPath, "utf8").trim();
          expect(["create-denied", "create-failed"]).toContain(reason);
          return;
        }
        expect(parent.status).toBe(0);

        const sawArmed = await waitForFile(armedPath, SURVIVED_POLL_MS);
        if (!sawArmed) {
          process.stdout.write(
            "[finalize-helper launch test] branch: launcher succeeded but helper's own guard refused to arm - asserting safe refusal\n",
          );
          expect(existsSync(notArmedPath)).toBe(true);
          return;
        }
        process.stdout.write(
          "[finalize-helper launch test] branch: armed - asserting survival past the launching process's exit\n",
        );
        const helperPid = Number.parseInt(readFileSync(armedPath, "utf8"), 10);
        expect(Number.isSafeInteger(helperPid)).toBe(true);
        helperPids.push(helperPid);
        expect(existsSync(survivedPath)).toBe(false);
        expect(() => process.kill(helperPid, 0)).not.toThrow();

        // Release it: what it writes now was written after the parent exited,
        // by the process that armed.
        writeFileSync(goPath, "");
        expect(await waitForFile(survivedPath, SURVIVED_POLL_MS)).toBe(true);
        expect(readFileSync(survivedPath, "utf8").trim()).toBe(
          String(helperPid),
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "never arms when the guard itself is confined to a no-breakaway KILL_ON_JOB_CLOSE job (deterministic control, independent of this runner's own ambient job state)",
      async () => {
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        let guardScriptPath = "";
        // Schedule only to get a real, fully-rendered production script on
        // disk; nothing here is actually launched by scheduleFinalizationHelper
        // itself - the confined run below is what exercises the guard.
        const scheduled = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(workRoot, "staged.exe"),
          livePath: join(workRoot, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: () => ({
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: NEVER_EXITS,
          }),
          writeImpl: async (path, body) => {
            if (!path.endsWith(".ps1")) {
              await defaultWriteImpl(path, body);
              return;
            }
            guardScriptPath = path.replace(/\.ps1$/, ".guard-only.ps1");
            await defaultWriteImpl(guardScriptPath, extractArmGuard(body));
          },
          armWait: fastClock(),
        });
        expect(scheduled.status).toBe("failed"); // nothing launched it
        expect(guardScriptPath).not.toBe("");

        // The guard-only copy's body still writes to its ORIGINAL script's
        // sibling `.armed`/`.not-armed` paths (they're baked into the
        // rendered text via `files.armedPath` etc.), not to paths derived
        // from the copy's own filename.
        const armedPath = scheduled.armedPath ?? "";
        const notArmedPath = armedPath.replace(/\.armed$/, ".not-armed");

        const run = runGuardUnderNoBreakawayJob(guardScriptPath, notArmedPath, {
          useBrokenNestedValueTypeAssignment: false,
        });
        expect(run.harnessError).toBeNull();
        expect(run.exitCode).toBe(0);
        expect(existsSync(armedPath)).toBe(false);
        expect(existsSync(notArmedPath)).toBe(true);
        expect(readFileSync(notArmedPath, "utf8")).toContain("in-job");
      },
      TEST_TIMEOUT_MS,
    );

    // Negative control for the read-back gate itself: this harness measured
    // that the broken nested-value-type assignment
    // (`$info.BasicLimitInformation.LimitFlags = ...` with no copy-out/
    // copy-in) reads back LimitFlags=0, not 0x2000 - the job it creates
    // isn't actually KILL_ON_JOB_CLOSE at all, which would make the "never
    // arms" control above pass for the wrong reason (or not at all) without
    // anyone noticing. Deliberately reproducing that bug here and asserting
    // the read-back gate catches it BEFORE any child is ever launched is
    // the red-first evidence that the gate does its job.
    it(
      "rejects a broken nested-value-type job-flags assignment via the read-back gate, before launching any child",
      async () => {
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        let guardScriptPath = "";
        const scheduled = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(workRoot, "staged.exe"),
          livePath: join(workRoot, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: () => ({
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: NEVER_EXITS,
          }),
          writeImpl: async (path, body) => {
            if (!path.endsWith(".ps1")) {
              await defaultWriteImpl(path, body);
              return;
            }
            guardScriptPath = path.replace(/\.ps1$/, ".guard-only.ps1");
            await defaultWriteImpl(guardScriptPath, extractArmGuard(body));
          },
          armWait: fastClock(),
        });
        expect(scheduled.status).toBe("failed"); // nothing launched it
        expect(guardScriptPath).not.toBe("");

        const armedPath = scheduled.armedPath ?? "";
        const notArmedPath = armedPath.replace(/\.armed$/, ".not-armed");

        const run = runGuardUnderNoBreakawayJob(guardScriptPath, notArmedPath, {
          useBrokenNestedValueTypeAssignment: true,
        });
        expect(run.harnessError).not.toBeNull();
        expect(run.harnessError).toContain("JobPolicyVerificationFailed");
        expect(run.exitCode).toBeNull();
        // The gate rejected the job BEFORE the confined guard script - or
        // anything else - was ever launched: neither outcome file exists,
        // because nothing ever ran that could have written either one.
        expect(existsSync(armedPath)).toBe(false);
        expect(existsSync(notArmedPath)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "never arms when the REAL launcher's own CreateProcessW is confined to a no-breakaway KILL_ON_JOB_CLOSE job before it runs",
      async () => {
        const recorded: RecordedLaunch[] = [];
        const recordingSpawn: SpawnImpl = (command, args, options) => {
          recorded.push({
            command,
            args,
            detached: options.detached,
            stdio: options.stdio,
            windowsHide: options.windowsHide,
          });
          return {
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: Promise.resolve({ exitCode: 0, errorMessage: null }),
          };
        };
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(workRoot, "staged.exe"),
          livePath: join(workRoot, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: recordingSpawn,
          writeImpl: defaultWriteImpl,
          armWait: fastClock(),
        });
        // The stub never actually launches anything, so scheduling itself
        // gives up - the recorded descriptor is what we launch for real below,
        // deliberately confined, instead of letting the production code path
        // launch it.
        expect(result.status).toBe("failed");
        expect(recorded).toHaveLength(1);
        const launch = recorded[0];
        if (launch === undefined) throw new Error("no launch was recorded");

        const armedPath = result.armedPath ?? "";
        const notArmedPath = armedPath.replace(/\.armed$/, ".not-armed");
        const commandLine = buildWin32CommandLine(launch.command, launch.args);
        const run = runCommandUnderNoBreakawayJob(commandLine, notArmedPath, {
          useBrokenNestedValueTypeAssignment: false,
        });
        expect(run.harnessError).toBeNull();

        // The confined launcher's own CreateProcessW is expected to be denied
        // outright (the job it's now in forbids CREATE_BREAKAWAY_FROM_JOB), or
        // - if it somehow still creates the helper - that helper's own guard
        // finds itself job-confined and refuses. Either shape is acceptable;
        // the only invariant that must NEVER be true is `.armed` appearing.
        // Which of the two failure shapes occurs is an implementation detail
        // this test doesn't pin down, but SOME diagnostic must exist - a
        // silent, unexplained refusal is exactly the kind of failure the
        // caller side needs a reason string for.
        expect(await waitForFile(notArmedPath, 5_000)).toBe(true);
        expect(existsSync(armedPath)).toBe(false);
        expect(
          readFileSync(notArmedPath, "utf8").trim().length,
        ).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS,
    );

    describe("a helper that arms after the CLI gave up", () => {
      // Runs the production script under real PowerShell, not detached.
      async function runAbandonedScript(opts: { readonly abandoned: boolean }) {
        const reachedPath = join(workRoot, "staged-reached");
        const stagedBinaryPath = join(workRoot, "staged-stub.cmd");
        writeFileSync(
          stagedBinaryPath,
          `@echo off\r\ntype nul > "${reachedPath}"\r\n`,
        );
        const exitedParent = spawnSync("cmd.exe", ["/c", "exit", "0"]);
        if (exitedParent.pid === undefined) {
          throw new Error("could not spawn cmd.exe to get an exited pid");
        }
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        const { cliPostFinalizeMarkerPath } = await import("../../store/paths");
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath,
          livePath: join(workRoot, "live.exe"),
          parentPid: exitedParent.pid,
          parentExitTimeoutSeconds: 2,
          platform: "win32",
          spawnImpl: () => ({
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: NEVER_EXITS,
          }),
          writeImpl: defaultWriteImpl,
          armWait: fastClock(),
        });
        expect(result.status).toBe("failed");
        const scriptPath = result.scriptPath ?? "";
        const abandonedPath = scriptPath.replace(/\.ps1$/, ".abandoned");
        expect(existsSync(abandonedPath)).toBe(true);
        if (!opts.abandoned) unlinkSync(abandonedPath);

        // Launched through the same CREATE_BREAKAWAY_FROM_JOB escape the
        // production launcher uses - a plain spawnSync here would make this
        // a direct, non-broken-away child of the test process, which the
        // new arm guard would always (correctly) refuse to arm, for
        // reasons that have nothing to do with what THIS test - the
        // abandoned-marker check that runs AFTER arming - is exercising.
        const run = runScriptWithBreakaway(scriptPath);
        const markerPath = cliPostFinalizeMarkerPath("production");
        expect(markerPath.startsWith(workHome)).toBe(true);
        const armedPath = result.armedPath ?? "";
        const notArmedPath = armedPath.replace(/\.armed$/, ".not-armed");
        return {
          harnessError: run.harnessError,
          exitCode: run.exitCode,
          armed: existsSync(armedPath),
          notArmedReason: existsSync(notArmedPath)
            ? readFileSync(notArmedPath, "utf8")
            : null,
          reached: existsSync(reachedPath),
          markerWritten: existsSync(markerPath),
        };
      }

      // Even `runScriptWithBreakaway`'s own escape can be denied outright:
      // if THIS runner's process tree sits inside a job whose policy never
      // grants breakaway, CreateProcessW with CREATE_BREAKAWAY_FROM_JOB
      // fails with ERROR_ACCESS_DENIED (Win32 error 5) rather than silently
      // succeeding into a still-confined process. That is the same safe
      // outcome the production guard exists to guarantee - nothing armed,
      // nothing finalized - so it is accepted here too, logged rather than
      // skipped, in place of the abandoned-vs-finalize assertions this
      // describe block otherwise exists to check (which need a helper that
      // actually got to run at all). Matched on the SPECIFIC error code,
      // not merely on "CreateProcessW failed": any other failure (a typo'd
      // path, a missing powershell.exe, ...) is a genuine harness bug and
      // must still fail the test rather than being swallowed as "maybe a
      // job policy".
      function isBreakawayAccessDenied(harnessError: string | null): boolean {
        return (
          harnessError !== null &&
          harnessError.includes("CreateProcessW") &&
          harnessError.includes("Win32 error 5)")
        );
      }

      // A SECOND, distinct safe outcome: CreateProcessW's own breakaway
      // request can succeed (escaping the job the throwaway launcher above
      // is in) while the resulting process is still confined by some
      // further-OUT job on this runner that the immediate breakaway request
      // never reached (freeze-9's actual failure mode - the CLI's own
      // process tree can be nested more than one job deep). The helper's
      // own IsProcessInJob guard catches that after the fact and writes
      // `.not-armed:in-job` instead of `.armed`, exiting 0 without touching
      // the staged binary or the marker - the same "refuse rather than
      // silently misbehave" contract, reached a different way.
      const FIXED_NOT_ARMED_REASONS = ["in-job", "job-check-failed"];

      // The create-denied branch: CreateProcessW itself never produced a
      // process, so there is nothing to expect a `.not-armed` write from -
      // absence of a marker here is fine, since nothing ran that could have
      // written one.
      function assertCreateDeniedRefusal(run: {
        readonly armed: boolean;
        readonly reached: boolean;
        readonly markerWritten: boolean;
      }): void {
        expect(run.armed).toBe(false);
        expect(run.reached).toBe(false);
        expect(run.markerWritten).toBe(false);
      }

      // The guard-refused branch: the script DID run (CreateProcessW
      // succeeded, `harnessError` is null) and chose not to arm. A `null`
      // `notArmedReason` here would let a pre-guard PowerShell crash -
      // Add-Type failing to load, a typo before the job check even runs -
      // masquerade as "the job refusal worked as designed", when it is
      // actually a broken test or a broken script. Require the fixed
      // reason the production guard actually writes, and its matching exit.
      function assertGuardRefusal(run: {
        readonly armed: boolean;
        readonly notArmedReason: string | null;
        readonly exitCode: number | null;
        readonly reached: boolean;
        readonly markerWritten: boolean;
      }): void {
        expect(run.armed).toBe(false);
        const reason = run.notArmedReason?.trim();
        expect(FIXED_NOT_ARMED_REASONS).toContain(reason);
        expect(run.exitCode).toBe(reason === "in-job" ? 0 : 1);
        expect(run.reached).toBe(false);
        expect(run.markerWritten).toBe(false);
      }

      it(
        "exits without finalizing once the CLI has abandoned it",
        async () => {
          const run = await runAbandonedScript({ abandoned: true });
          if (isBreakawayAccessDenied(run.harnessError)) {
            process.stdout.write(
              `[finalize-helper launch test] branch: breakaway access-denied on this runner (${run.harnessError}) - asserting safe refusal\n`,
            );
            assertCreateDeniedRefusal(run);
            return;
          }
          expect(run.harnessError).toBeNull();
          if (!run.armed) {
            process.stdout.write(
              `[finalize-helper launch test] branch: broke away but still job-confined (reason=${run.notArmedReason}) - asserting safe refusal\n`,
            );
            assertGuardRefusal(run);
            return;
          }
          process.stdout.write(
            "[finalize-helper launch test] branch: armed - asserting abandoned marker prevented finalize\n",
          );
          expect(run.exitCode).toBe(0);
          expect(run.reached).toBe(false);
          expect(run.markerWritten).toBe(false);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "finalizes through the staged binary when nothing abandoned it",
        async () => {
          const run = await runAbandonedScript({ abandoned: false });
          if (isBreakawayAccessDenied(run.harnessError)) {
            process.stdout.write(
              `[finalize-helper launch test] branch: breakaway access-denied on this runner (${run.harnessError}) - asserting safe refusal\n`,
            );
            assertCreateDeniedRefusal(run);
            return;
          }
          expect(run.harnessError).toBeNull();
          if (!run.armed) {
            process.stdout.write(
              `[finalize-helper launch test] branch: broke away but still job-confined (reason=${run.notArmedReason}) - asserting safe refusal\n`,
            );
            assertGuardRefusal(run);
            return;
          }
          process.stdout.write(
            "[finalize-helper launch test] branch: armed - asserting finalize reached the staged binary\n",
          );
          expect(run.exitCode).toBe(0);
          expect(run.reached).toBe(true);
        },
        TEST_TIMEOUT_MS,
      );
    });
  },
);
