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
// arming is observed - even Reflection.Emit's dynamic-assembly/JIT cost on a
// loaded CI box can take a couple of seconds, so this needs real margin
// rather than
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

// The shared in-memory native-binding emitter every harness below uses in
// place of `Add-Type`. Confirmed on a Windows VM: `Add-Type -TypeDefinition`
// shells out to csc.exe, which writes compiler temp files under the process
// TEMP path - when that path contains CJK characters, `Add-Type` throws a
// Win32Exception before any of these harnesses' own logic ever runs. Every
// P/Invoke type here is built purely from `System.Reflection.Emit` (an
// in-memory dynamic assembly), with zero dependency on an external compiler
// process or its temp files - mirroring the same technique the production
// launcher and helper scripts (`finalize-helper.ts`) already use.
//
// Every emitted method returns a primitive (`int`/`uint32`/`IntPtr`) rather
// than `bool`, and every struct-shaped parameter (STARTUPINFO,
// PROCESS_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, and any `out`
// parameter) is a raw `AllocHGlobal` buffer read/written at fixed offsets
// instead of a marshaled .NET struct - deliberately the simplest, most
// primitive P/Invoke surface Reflection.Emit can describe, since marshaling
// attributes (`[MarshalAs(...)]`, `ref`/`out` struct parameters) are far less
// exercised via Reflection.Emit than plain primitive signatures and cannot be
// verified without a Windows VM.
//
// A spec's `WrapWithErrorCapture` flag additionally emits a same-signature
// `Try<Name>` method that returns 0 on success or the immediately-captured
// `GetLastWin32Error()` on failure: PowerShell re-querying
// `[Marshal]::GetLastWin32Error()` AFTER a P/Invoke call returns reads a
// CLOBBERED value on Windows PowerShell 5.1 (confirmed on a Windows VM) - the
// only reliable capture point is inside the same emitted method, with no
// PowerShell interpreter frames between the native call and the read.
const WINDOWS_TEST_NATIVE_EMIT_LINES: readonly string[] = [
  "function New-TraycerTestNativeType {",
  "  param([string]$Name, [object[]]$Methods)",
  "  $assemblyName = [System.Reflection.AssemblyName]::new($Name)",
  "  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(",
  "    $assemblyName, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)",
  "  $module = $assembly.DefineDynamicModule($Name)",
  "  $typeFlags = [System.Reflection.TypeAttributes]::Public -bor",
  "    [System.Reflection.TypeAttributes]::Sealed -bor",
  "    [System.Reflection.TypeAttributes]::Abstract",
  "  $builder = $module.DefineType($Name, $typeFlags)",
  "  $methodFlags = [System.Reflection.MethodAttributes]::Public -bor",
  "    [System.Reflection.MethodAttributes]::Static -bor",
  "    [System.Reflection.MethodAttributes]::PinvokeImpl",
  // W-H5 (conclusive): `TypeBuilder.DefinePInvokeMethod` and a
  // hand-attached `DllImportAttribute` on the SAME method are two
  // independent, overlapping descriptions of the same P/Invoke -
  // `DefinePInvokeMethod` already implies its own interop metadata from the
  // arguments it's given, and layering a second, manually built
  // `DllImportAttribute` on top is undefined/fragile - W-H5 measured the old
  // (A) binding misclassifying a denied breakaway as Win32 error 203, where
  // the corrected (B) binding here measures the real 5 (ACCESS_DENIED).
  // Every native method here is instead a plain `DefineMethod` (flagged
  // `PinvokeImpl`, no IL body) carrying exactly ONE complete, manually
  // constructed `DllImportAttribute` naming every field that matters:
  // `EntryPoint`, `CharSet`, `CallingConvention`, `ExactSpelling`,
  // `SetLastError` and `PreserveSig`.
  "  $importCtor = [System.Runtime.InteropServices.DllImportAttribute].GetConstructor([type[]]@([string]))",
  "  $importFields = [System.Reflection.FieldInfo[]]@(",
  "    [System.Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'),",
  "    [System.Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),",
  "    [System.Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'),",
  "    [System.Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'),",
  "    [System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),",
  "    [System.Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig'))",
  "  $methodsByName = @{}",
  "  foreach ($spec in $Methods) {",
  "    $parameters = [type[]]$spec.ParameterTypes",
  "    $method = $builder.DefineMethod(",
  "      $spec.Name, $methodFlags, $spec.ReturnType, $parameters)",
  "    $import = [System.Reflection.Emit.CustomAttributeBuilder]::new(",
  "      $importCtor, [object[]]@($spec.Dll), $importFields,",
  "      [object[]]@(",
  "        $spec.EntryPoint,",
  "        [System.Runtime.InteropServices.CharSet]::Unicode,",
  "        [System.Runtime.InteropServices.CallingConvention]::Winapi,",
  "        $true, $true, $true))",
  "    $method.SetCustomAttribute($import)",
  "    $method.SetImplementationFlags(",
  "      $method.GetMethodImplementationFlags() -bor",
  "      [System.Reflection.MethodImplAttributes]::PreserveSig)",
  "    $methodsByName[$spec.Name] = @{ Method = $method; Parameters = $parameters }",
  "  }",
  "  foreach ($spec in $Methods) {",
  "    if (-not $spec.WrapWithErrorCapture) { continue }",
  "    $entry = $methodsByName[$spec.Name]",
  "    $wrapperFlags = [System.Reflection.MethodAttributes]::Public -bor",
  "      [System.Reflection.MethodAttributes]::Static",
  "    $wrapper = $builder.DefineMethod(",
  '      "Try$($spec.Name)", $wrapperFlags, [int], $entry.Parameters)',
  "    $il = $wrapper.GetILGenerator()",
  "    for ($index = 0; $index -lt $entry.Parameters.Length; $index++) {",
  "      $il.Emit([System.Reflection.Emit.OpCodes]::Ldarg_S, [byte]$index)",
  "    }",
  "    $il.Emit([System.Reflection.Emit.OpCodes]::Call, $entry.Method)",
  "    $failed = $il.DefineLabel()",
  "    $il.Emit([System.Reflection.Emit.OpCodes]::Brfalse_S, $failed)",
  "    $il.Emit([System.Reflection.Emit.OpCodes]::Ldc_I4_0)",
  "    $il.Emit([System.Reflection.Emit.OpCodes]::Ret)",
  "    $il.MarkLabel($failed)",
  "    $errorMethod = [System.Runtime.InteropServices.Marshal].GetMethod(",
  "      'GetLastWin32Error', [type[]]@())",
  "    $il.Emit([System.Reflection.Emit.OpCodes]::Call, $errorMethod)",
  "    $il.Emit([System.Reflection.Emit.OpCodes]::Ret)",
  "  }",
  "  return $builder.CreateType()",
  "}",
];

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
    ...WINDOWS_TEST_NATIVE_EMIT_LINES,
    "$ErrorActionPreference = 'Stop'",
    "$native = New-TraycerTestNativeType 'TraycerJobProbe' @(",
    "  @{ Name = 'OpenProcess'; Dll = 'kernel32.dll'; EntryPoint = 'OpenProcess'; ReturnType = [IntPtr]; ParameterTypes = [type[]]@([uint32], [int], [int]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'IsProcessInJob'; Dll = 'kernel32.dll'; EntryPoint = 'IsProcessInJob'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr], [IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'CloseHandle'; Dll = 'kernel32.dll'; EntryPoint = 'CloseHandle'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr]); WrapWithErrorCapture = $false }",
    ")",
    "$resultPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)",
    "[System.Runtime.InteropServices.Marshal]::WriteInt32($resultPtr, 0)",
    "$h = [IntPtr]::Zero",
    "try {",
    `  $h = $native.GetMethod('OpenProcess').Invoke($null, [object[]]@([uint32]0x1000, 0, ${pid}))`,
    "  if ($h -eq [IntPtr]::Zero) { Write-Output 'OPEN_FAILED'; exit 1 }",
    "  $ok = [int]$native.GetMethod('IsProcessInJob').Invoke($null, [object[]]@($h, [IntPtr]::Zero, $resultPtr))",
    "  if ($ok -eq 0) { Write-Output 'QUERY_FAILED'; exit 1 }",
    "  $result = [bool]([System.Runtime.InteropServices.Marshal]::ReadInt32($resultPtr) -ne 0)",
    "  Write-Output $result",
    "} finally {",
    "  if ($h -ne [IntPtr]::Zero) { [void]$native.GetMethod('CloseHandle').Invoke($null, [object[]]@($h)) }",
    "  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($resultPtr)",
    "}",
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

// A STRICTER variant of `assertArmedOrRefused`, for a CJK TEMP path
// specifically: the only refusals this accepts are the two FIXED JOB-POLICY
// ones - `create-denied` (CreateProcessW's own breakaway request was denied
// outright by an outer job policy) and `in-job` (breakaway succeeded, but
// the helper is still confined by some further-out job policy the guard
// then caught) - both runner-state facts that have nothing to do with the
// path's characters (W-FIX-SMOKE S3b: a legitimate nested no-breakaway
// runner can genuinely produce `in-job` here). Any OTHER outcome
// (`create-failed`, `job-check-failed`, `launcher-failed`, or no
// `.not-armed` file at all) is treated as a failure here, because that is
// exactly the silent, undiagnosable shape a CJK-TEMP-triggered
// native-binding failure would take: the whole point of building bindings
// via Reflection.Emit instead of Add-Type/csc is that a CJK TEMP path must
// no longer be able to produce that failure mode. Using the loose
// `assertArmedOrRefused` here would let such a regression hide behind
// "refused is always an acceptable branch." VM C1 must always ARM; only a
// CI runner sitting inside a restrictive/nested job may legitimately take
// the job-policy-refusal branch instead.
function assertArmsUnlessJobPolicyRefused(result: ArmResultLike): void {
  const notArmedPath = (result.armedPath ?? "").replace(
    /\.armed$/,
    ".not-armed",
  );
  if (result.status !== "armed") {
    const reason = existsSync(notArmedPath)
      ? readFileSync(notArmedPath, "utf8").trim()
      : null;
    if (reason === "create-denied" || reason === "in-job") {
      process.stdout.write(
        `[finalize-helper launch test] branch: CJK TEMP - fixed job-policy refusal on this runner (reason=${reason}) - asserting safe refusal\n`,
      );
      expect(result.status).toBe("failed");
      expect(existsSync(result.armedPath ?? "")).toBe(false);
      return;
    }
    throw new Error(
      `expected the helper to arm under a CJK TEMP path (or refuse with a fixed job-policy reason), but it did neither: status=${result.status}, .not-armed reason=${JSON.stringify(reason)} - a CJK-TEMP-triggered native-binding failure would look exactly like this`,
    );
  }
  process.stdout.write(
    `[finalize-helper launch test] branch: CJK TEMP - armed (helperPid=${result.helperPid})\n`,
  );
  expect(existsSync(result.armedPath ?? "")).toBe(true);
  if (result.helperPid !== null) {
    helperPids.push(result.helperPid);
    expect(probeIsProcessInJob(result.helperPid)).toBe(false);
  }
}

// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway bits.
const KILL_ON_JOB_CLOSE_NO_BREAKAWAY = 0x2000;

// Matches the production helper script's own leading byte - used only for
// this file's own tiny probe scripts (`probeBreakawayCapability`).
const UTF8_BOM = "﻿";

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
// does not honour LimitFlags for this purpose) is rejected by the API. The
// struct itself is now a raw `AllocHGlobal` buffer (see
// `WINDOWS_TEST_NATIVE_EMIT_LINES` above for why), sized to the documented
// x86/x64 byte layout: `LimitFlags` sits at a fixed offset of 16 bytes on
// BOTH architectures, since it is preceded by exactly two 8-byte
// LARGE_INTEGER fields (PerProcessUserTimeLimit, PerJobUserTimeLimit) and
// BasicLimitInformation is the extended struct's own first field.
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
// `simulateBrokenNestedValueTypeAssignment` is TEST-ONLY, off by default: it
// reproduces the ACTUAL historical PowerShell nested-value-type-copy bug
// (`$info.BasicLimitInformation.LimitFlags = X` mutating a COPY PowerShell
// handed back, never reaching the real struct) against a small,
// purpose-built Reflection.Emit value-type pair, then feeds whatever
// `LimitFlags` value that bug actually produces (0, since the write never
// lands) into the real job-info buffer below - see the driver body for the
// full reproduction. This exercises the read-back gate (never trust the SET
// call's own success) against a genuine defect, not a stand-in that merely
// skips a write.
function runCommandUnderNoBreakawayJob(
  commandLine: string,
  watchPath: string,
  opts: { readonly simulateBrokenNestedValueTypeAssignment: boolean },
): {
  readonly exitCode: number | null;
  readonly harnessError: string | null;
} {
  const driver = [
    ...WINDOWS_TEST_NATIVE_EMIT_LINES,
    "$ErrorActionPreference = 'Stop'",
    "$native = New-TraycerTestNativeType 'TraycerJobHarness' @(",
    "  @{ Name = 'CreateJobObject'; Dll = 'kernel32.dll'; EntryPoint = 'CreateJobObjectW'; ReturnType = [IntPtr]; ParameterTypes = [type[]]@([IntPtr], [IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'SetInformationJobObject'; Dll = 'kernel32.dll'; EntryPoint = 'SetInformationJobObject'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [int], [IntPtr], [uint32]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'QueryInformationJobObject'; Dll = 'kernel32.dll'; EntryPoint = 'QueryInformationJobObject'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [int], [IntPtr], [uint32], [IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'AssignProcessToJobObject'; Dll = 'kernel32.dll'; EntryPoint = 'AssignProcessToJobObject'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'CreateProcessNative'; Dll = 'kernel32.dll'; EntryPoint = 'CreateProcessW'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr], [IntPtr], [IntPtr], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr]); WrapWithErrorCapture = $true },",
    "  @{ Name = 'ResumeThread'; Dll = 'kernel32.dll'; EntryPoint = 'ResumeThread'; ReturnType = [uint32]; ParameterTypes = [type[]]@([IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'WaitForSingleObject'; Dll = 'kernel32.dll'; EntryPoint = 'WaitForSingleObject'; ReturnType = [uint32]; ParameterTypes = [type[]]@([IntPtr], [uint32]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'GetExitCodeProcess'; Dll = 'kernel32.dll'; EntryPoint = 'GetExitCodeProcess'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'CloseHandle'; Dll = 'kernel32.dll'; EntryPoint = 'CloseHandle'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr]); WrapWithErrorCapture = $false }",
    ")",
    // `Fail` is for the OTHER API calls, where PowerShell's own
    // [Marshal]::GetLastWin32Error() is the only source available -
    // CreateProcessW's error is instead captured natively (see the
    // WrapWithErrorCapture spec above) and reported inline at its call site.
    "function Fail($step) {",
    "  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    `  Write-Output "${HARNESS_ERROR_PREFIX}$step (Win32 error $code)"`,
    "  exit 1",
    "}",
    // `lpName` = PowerShell `$null` bound to an EMPTY STRING, not a true
    // NULL pointer, for both `New-Object` and `::new` string-typed
    // constructor forms (W-H123's A/B/C/D result on a Windows VM) -
    // CreateProcessW's own `lpApplicationName`/`lpCurrentDirectory` hit the
    // identical trap and failed with Win32 error 123 until moved to
    // `[IntPtr]::Zero`, a genuine null pointer. `CreateJobObject`'s `lpName`
    // takes the same all-IntPtr binding production itself uses for this
    // class of parameter.
    "$job = $native.GetMethod('CreateJobObject').Invoke($null, [object[]]@([IntPtr]::Zero, [IntPtr]::Zero))",
    'if ($job -eq [IntPtr]::Zero) { Fail("CreateJobObject") }',
    // JOBOBJECT_BASIC_LIMIT_INFORMATION is 64 bytes on x64 (two 8-byte
    // LARGE_INTEGER fields, a 4-byte LimitFlags, 4 bytes of padding to
    // re-align the pointer-sized fields that follow it, then
    // Min/MaximumWorkingSetSize + ActiveProcessLimit + padding + Affinity +
    // PriorityClass + SchedulingClass filling out to 64) and 48 bytes on
    // x86 (no padding needed; every field naturally 4-aligned, then rounded
    // up to the struct's own 8-byte alignment from the LARGE_INTEGER
    // fields). JOBOBJECT_EXTENDED_LIMIT_INFORMATION adds IO_COUNTERS (48
    // bytes, six ULONGLONGs) plus four trailing SIZE_T fields: x64 =
    // 64 + 48 + 4*8 = 144; x86 = 48 + 48 + 4*4 = 112.
    "$infoSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }",
    "$info = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($infoSize)",
    "$zeroInfo = [byte[]]([System.Array]::CreateInstance([byte], $infoSize))",
    "[System.Runtime.InteropServices.Marshal]::Copy($zeroInfo, 0, $info, $infoSize)",
    // LimitFlags sits at a fixed offset of 16 bytes on BOTH architectures -
    // it's inside the first 20 bytes of BasicLimitInformation (after the two
    // 8-byte LARGE_INTEGER fields), entirely before any pointer-size-driven
    // padding, and BasicLimitInformation is the extended struct's own first
    // field.
    "$limitFlagsOffset = 16",
    // Reproduce the ACTUAL PowerShell nested-value-type-copy bug against a
    // real emitted struct pair, rather than merely skipping a raw-buffer
    // write: a tiny in-memory Inner/Outer value-type pair, built the same
    // Reflection.Emit way as the P/Invoke types above (no Add-Type, no
    // struct-marshaling P/Invoke involved - this is plain managed-code value
    // semantics). The BROKEN path assigns straight into
    // `$nestedOuter.Inner.LimitFlags`, which PowerShell resolves by reading
    // `.Inner` (a COPY, since Inner is a value type), mutating that copy,
    // and discarding it - `$nestedOuter` itself is never touched, so
    // `$nestedOuter.Inner.LimitFlags` reads back 0 afterward. The CORRECT
    // path round-trips through a local variable instead. Whichever value
    // comes back is what actually gets written into the real job-info
    // buffer below, so the read-back gate is exercised against a genuinely
    // reproduced defect, not a stand-in.
    "$nestedAssemblyName = [System.Reflection.AssemblyName]::new('TraycerNestedLimitCheck')",
    "$nestedAssembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(",
    "  $nestedAssemblyName, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)",
    "$nestedModule = $nestedAssembly.DefineDynamicModule('TraycerNestedLimitCheck')",
    "$innerBuilder = $nestedModule.DefineType('TraycerNestedInner',",
    "  [System.Reflection.TypeAttributes]::Public -bor",
    "  [System.Reflection.TypeAttributes]::SequentialLayout -bor",
    "  [System.Reflection.TypeAttributes]::Sealed, [System.ValueType])",
    "[void]$innerBuilder.DefineField('LimitFlags', [uint32], [System.Reflection.FieldAttributes]::Public)",
    "$innerType = $innerBuilder.CreateType()",
    "$outerBuilder = $nestedModule.DefineType('TraycerNestedOuter',",
    "  [System.Reflection.TypeAttributes]::Public -bor",
    "  [System.Reflection.TypeAttributes]::SequentialLayout -bor",
    "  [System.Reflection.TypeAttributes]::Sealed, [System.ValueType])",
    "[void]$outerBuilder.DefineField('Inner', $innerType, [System.Reflection.FieldAttributes]::Public)",
    "$outerType = $outerBuilder.CreateType()",
    "$nestedOuter = [System.Activator]::CreateInstance($outerType)",
    ...(opts.simulateBrokenNestedValueTypeAssignment
      ? [
          // DELIBERATELY BROKEN, test-only: mutates a COPY of the nested
          // value type PowerShell handed back, never reaching `$nestedOuter`
          // itself. See the surrounding comment for why.
          `$nestedOuter.Inner.LimitFlags = [uint32]${KILL_ON_JOB_CLOSE_NO_BREAKAWAY}`,
        ]
      : [
          "$nestedInner = $nestedOuter.Inner",
          `$nestedInner.LimitFlags = [uint32]${KILL_ON_JOB_CLOSE_NO_BREAKAWAY}`,
          "$nestedOuter.Inner = $nestedInner",
        ]),
    "$limitFlagsToWrite = [uint32]$nestedOuter.Inner.LimitFlags",
    "[System.Runtime.InteropServices.Marshal]::WriteInt32($info, $limitFlagsOffset, [int]$limitFlagsToWrite)",
    "if ([int]$native.GetMethod('SetInformationJobObject').Invoke($null, [object[]]@($job, 9, $info, [uint32]$infoSize)) -eq 0) {",
    '  Fail("SetInformationJobObject")',
    "}",
    // Read the policy back from the OS rather than trusting the SET call's
    // own success - `SetInformationJobObject` returning TRUE only means the
    // API accepted the call, not that the flags we THINK we sent are the
    // flags that landed. This must run BEFORE the confined child is ever
    // created: a job that isn't actually KILL_ON_JOB_CLOSE-only would make
    // this whole control meaningless without anyone noticing.
    "$readBack = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($infoSize)",
    "[System.Runtime.InteropServices.Marshal]::Copy($zeroInfo, 0, $readBack, $infoSize)",
    "$returnedLengthPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)",
    "if ([int]$native.GetMethod('QueryInformationJobObject').Invoke($null, [object[]]@($job, 9, $readBack, [uint32]$infoSize, $returnedLengthPtr)) -eq 0) {",
    '  Fail("QueryInformationJobObject")',
    "}",
    "$actualLimitFlags = [uint32][System.Runtime.InteropServices.Marshal]::ReadInt32($readBack, $limitFlagsOffset)",
    `if ($actualLimitFlags -ne [uint32]${KILL_ON_JOB_CLOSE_NO_BREAKAWAY}) {`,
    '  $actualHex = "{0:X}" -f $actualLimitFlags',
    `  Write-Output "${HARNESS_ERROR_PREFIX}JobPolicyVerificationFailed (expected 0x${KILL_ON_JOB_CLOSE_NO_BREAKAWAY.toString(16)}, read back 0x$actualHex)"`,
    "  exit 1",
    "}",
    "[System.Runtime.InteropServices.Marshal]::FreeHGlobal($readBack)",
    "[System.Runtime.InteropServices.Marshal]::FreeHGlobal($returnedLengthPtr)",
    "$startupSize = if ([IntPtr]::Size -eq 8) { 104 } else { 68 }",
    "$processInfoSize = if ([IntPtr]::Size -eq 8) { 24 } else { 16 }",
    "$startup = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($startupSize)",
    "$processInfo = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($processInfoSize)",
    "$zeroStartup = [byte[]]([System.Array]::CreateInstance([byte], $startupSize))",
    "$zeroProcessInfo = [byte[]]([System.Array]::CreateInstance([byte], $processInfoSize))",
    "[System.Runtime.InteropServices.Marshal]::Copy($zeroStartup, 0, $startup, $startupSize)",
    "[System.Runtime.InteropServices.Marshal]::Copy($zeroProcessInfo, 0, $processInfo, $processInfoSize)",
    "[System.Runtime.InteropServices.Marshal]::WriteInt32($startup, $startupSize)",
    // The StringBuilder is only a convenient way to prepare/quote the
    // literal PowerShell-side; production's own launcher binds
    // lpCommandLine as a raw IntPtr, not a StringBuilder P/Invoke
    // parameter, so this harness matches that all-IntPtr signature too -
    // marshal the built string into a writable HGlobal buffer before the
    // call, exactly as `$command` is built in the production script.
    `$cmd = New-Object System.Text.StringBuilder(${powershellSingleQuoted(commandLine)})`,
    "$command = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($cmd.ToString())",
    "$createLastError = [int]$native.GetMethod('TryCreateProcessNative').Invoke(",
    "  $null, [object[]]@(",
    "    [IntPtr]::Zero, $command, [IntPtr]::Zero, [IntPtr]::Zero, 0,",
    "    [uint32]0x00000004, [IntPtr]::Zero, [IntPtr]::Zero, $startup, $processInfo))",
    "[System.Runtime.InteropServices.Marshal]::FreeHGlobal($command)",
    "if ($createLastError -ne 0) {",
    `  Write-Output "${HARNESS_ERROR_PREFIX}CreateProcessW (Win32 error $createLastError)"`,
    "  exit 1",
    "}",
    "$hProcess = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 0)",
    "$hThread = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, [IntPtr]::Size)",
    "if ([int]$native.GetMethod('AssignProcessToJobObject').Invoke($null, [object[]]@($job, $hProcess)) -eq 0) {",
    '  Fail("AssignProcessToJobObject")',
    "}",
    "[uint32]$resumeResult = [uint32]$native.GetMethod('ResumeThread').Invoke($null, [object[]]@($hThread))",
    "if ($resumeResult -eq [uint32]::MaxValue) {",
    '  Fail("ResumeThread")',
    "}",
    "$waitResult = [uint32]$native.GetMethod('WaitForSingleObject').Invoke($null, [object[]]@($hProcess, [uint32]30000))",
    "if ($waitResult -ne 0) {",
    '  Fail("WaitForSingleObject (not WAIT_OBJECT_0)")',
    "}",
    "$exitCodePtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)",
    "if ([int]$native.GetMethod('GetExitCodeProcess').Invoke($null, [object[]]@($hProcess, $exitCodePtr)) -eq 0) {",
    '  Fail("GetExitCodeProcess")',
    "}",
    "[uint32]$exitCode = [System.Runtime.InteropServices.Marshal]::ReadInt32($exitCodePtr)",
    "[void]$native.GetMethod('CloseHandle').Invoke($null, [object[]]@($hThread))",
    "[void]$native.GetMethod('CloseHandle').Invoke($null, [object[]]@($hProcess))",
    "[System.Runtime.InteropServices.Marshal]::FreeHGlobal($exitCodePtr)",
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
  opts: { readonly simulateBrokenNestedValueTypeAssignment: boolean },
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
    ...WINDOWS_TEST_NATIVE_EMIT_LINES,
    "$ErrorActionPreference = 'Stop'",
    "$native = New-TraycerTestNativeType 'TraycerBreakawayLauncher' @(",
    "  @{ Name = 'CreateProcessNative'; Dll = 'kernel32.dll'; EntryPoint = 'CreateProcessW'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr], [IntPtr], [IntPtr], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr]); WrapWithErrorCapture = $true },",
    "  @{ Name = 'WaitForSingleObject'; Dll = 'kernel32.dll'; EntryPoint = 'WaitForSingleObject'; ReturnType = [uint32]; ParameterTypes = [type[]]@([IntPtr], [uint32]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'GetExitCodeProcess'; Dll = 'kernel32.dll'; EntryPoint = 'GetExitCodeProcess'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr]); WrapWithErrorCapture = $false },",
    "  @{ Name = 'CloseHandle'; Dll = 'kernel32.dll'; EntryPoint = 'CloseHandle'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr]); WrapWithErrorCapture = $false }",
    ")",
    "function Fail($step) {",
    "  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    `  Write-Output "${HARNESS_ERROR_PREFIX}$step (Win32 error $code)"`,
    "  exit 1",
    "}",
    "$startupSize = if ([IntPtr]::Size -eq 8) { 104 } else { 68 }",
    "$processInfoSize = if ([IntPtr]::Size -eq 8) { 24 } else { 16 }",
    "$startup = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($startupSize)",
    "$processInfo = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($processInfoSize)",
    "$zeroStartup = [byte[]]([System.Array]::CreateInstance([byte], $startupSize))",
    "$zeroProcessInfo = [byte[]]([System.Array]::CreateInstance([byte], $processInfoSize))",
    "[System.Runtime.InteropServices.Marshal]::Copy($zeroStartup, 0, $startup, $startupSize)",
    "[System.Runtime.InteropServices.Marshal]::Copy($zeroProcessInfo, 0, $processInfo, $processInfoSize)",
    "[System.Runtime.InteropServices.Marshal]::WriteInt32($startup, $startupSize)",
    // Same native-capture wrapper as `runCommandUnderNoBreakawayJob` -
    // PowerShell re-querying [Marshal]::GetLastWin32Error() after the
    // P/Invoke returns reads a clobbered value on PS5.1, so
    // `isBreakawayAccessDenied` (which keys off Win32 error 5) needs the
    // real code captured natively instead. `lpApplicationName` and
    // `lpCurrentDirectory` are `[IntPtr]::Zero`, not a `$null` string, and
    // `lpCommandLine` is a writable HGlobal buffer, not a StringBuilder
    // P/Invoke parameter - the StringBuilder here only prepares/quotes the
    // literal - matching production's all-IntPtr binding exactly (see the
    // W-H123/all-IntPtr note on `runCommandUnderNoBreakawayJob` above).
    `$cmd = New-Object System.Text.StringBuilder(${powershellSingleQuoted(commandLine)})`,
    "$command = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($cmd.ToString())",
    `$flags = [uint32](${CREATE_BREAKAWAY_FROM_JOB} -bor ${CREATE_NO_WINDOW})`,
    "$createLastError = [int]$native.GetMethod('TryCreateProcessNative').Invoke(",
    "  $null, [object[]]@(",
    "    [IntPtr]::Zero, $command, [IntPtr]::Zero, [IntPtr]::Zero, 0,",
    "    $flags, [IntPtr]::Zero, [IntPtr]::Zero, $startup, $processInfo))",
    "[System.Runtime.InteropServices.Marshal]::FreeHGlobal($command)",
    "if ($createLastError -ne 0) {",
    `  Write-Output "${HARNESS_ERROR_PREFIX}CreateProcessW (Win32 error $createLastError)"`,
    "  exit 1",
    "}",
    "$hProcess = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 0)",
    "$hThread = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, [IntPtr]::Size)",
    "$waitResult = [uint32]$native.GetMethod('WaitForSingleObject').Invoke($null, [object[]]@($hProcess, [uint32]30000))",
    "if ($waitResult -ne 0) {",
    '  Fail("WaitForSingleObject (not WAIT_OBJECT_0)")',
    "}",
    "$exitCodePtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)",
    "if ([int]$native.GetMethod('GetExitCodeProcess').Invoke($null, [object[]]@($hProcess, $exitCodePtr)) -eq 0) {",
    '  Fail("GetExitCodeProcess")',
    "}",
    "[uint32]$exitCode = [System.Runtime.InteropServices.Marshal]::ReadInt32($exitCodePtr)",
    "[void]$native.GetMethod('CloseHandle').Invoke($null, [object[]]@($hThread))",
    "[void]$native.GetMethod('CloseHandle').Invoke($null, [object[]]@($hProcess))",
    "[System.Runtime.InteropServices.Marshal]::FreeHGlobal($exitCodePtr)",
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

// Even `runScriptWithBreakaway`'s own escape can be denied outright: if THIS
// runner's process tree sits inside a job whose policy never grants
// breakaway, CreateProcessW with CREATE_BREAKAWAY_FROM_JOB fails with
// ERROR_ACCESS_DENIED (Win32 error 5) rather than silently succeeding into a
// still-confined process. Matched on the SPECIFIC error code, not merely on
// "CreateProcessW failed": any other failure (a typo'd path, a missing
// powershell.exe, ...) is a genuine harness bug and must still fail the test
// rather than being swallowed as "maybe a job policy".
function isBreakawayAccessDenied(harnessError: string | null): boolean {
  return (
    harnessError !== null &&
    harnessError.includes("CreateProcessW") &&
    harnessError.includes("Win32 error 5)")
  );
}

// An independent, MEASURED answer to "can a breakaway child of THIS exact
// process tree actually escape its job right now, under this CJK TEMP
// path" - answered by actually launching one (via `runScriptWithBreakaway`,
// the same CREATE_BREAKAWAY_FROM_JOB escape the production launcher itself
// uses, so the probe is a child of the identical job chain the real
// launcher would be), rather than assumed from the real schedule call's own
// self-reported reason. This is what lets the CJK test REQUIRE `armed`
// specifically when this runner's job chain is measurably capable of
// breakaway - only when the probe independently proves the runner itself
// cannot break away, or ends up still job-confined, is a fixed job-policy
// refusal from the real call acceptable; a CJK-triggered native-binding
// failure could otherwise hide behind "well, refusal is always plausible."
//
// The probe script is a tiny BOM'd PowerShell script (matching the
// production helper's own BOM) built from the SAME
// `WINDOWS_TEST_NATIVE_EMIT_LINES` in-memory emitter used everywhere else in
// this file - GetCurrentProcess + IsProcessInJob, nothing else - and writes
// exactly one of `job-free` / `in-job` to a marker file. Any probe setup
// failure (a `catch` inside the script, a missing marker, an unexpected
// marker value) is a HARD failure here, never swallowed - the probe's whole
// purpose is to remove ambiguity, so an ambiguous probe result must not
// itself be treated as "fine, could be anything."
function probeBreakawayCapability(
  dir: string,
): "job-free" | "in-job" | "denied" {
  const probeScriptPath = join(dir, "capability-probe.ps1");
  const markerPath = join(dir, "capability-probe.result");
  const probeScript = [
    UTF8_BOM +
      "$ErrorActionPreference = 'Stop'\n" +
      `$MarkerPath = ${powershellSingleQuoted(markerPath)}`,
    ...WINDOWS_TEST_NATIVE_EMIT_LINES,
    "try {",
    "  $native = New-TraycerTestNativeType 'TraycerCapabilityProbe' @(",
    "    @{ Name = 'GetCurrentProcess'; Dll = 'kernel32.dll'; EntryPoint = 'GetCurrentProcess'; ReturnType = [IntPtr]; ParameterTypes = [type[]]@(); WrapWithErrorCapture = $false },",
    "    @{ Name = 'IsProcessInJob'; Dll = 'kernel32.dll'; EntryPoint = 'IsProcessInJob'; ReturnType = [int]; ParameterTypes = [type[]]@([IntPtr], [IntPtr], [IntPtr]); WrapWithErrorCapture = $false }",
    "  )",
    "  $resultPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)",
    "  [System.Runtime.InteropServices.Marshal]::WriteInt32($resultPtr, 0)",
    "  $current = $native.GetMethod('GetCurrentProcess').Invoke($null, [object[]]@())",
    "  $ok = [int]$native.GetMethod('IsProcessInJob').Invoke($null, [object[]]@($current, [IntPtr]::Zero, $resultPtr))",
    "  if ($ok -eq 0) {",
    "    [System.IO.File]::WriteAllText($MarkerPath, 'probe-query-failed')",
    "  } else {",
    "    $inJob = [System.Runtime.InteropServices.Marshal]::ReadInt32($resultPtr) -ne 0",
    "    [System.IO.File]::WriteAllText($MarkerPath, $(if ($inJob) { 'in-job' } else { 'job-free' }))",
    "  }",
    "  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($resultPtr)",
    "} catch {",
    "  [System.IO.File]::WriteAllText($MarkerPath, 'probe-error')",
    "}",
  ].join("\n");
  writeFileSync(probeScriptPath, probeScript, "utf8");
  const run = runScriptWithBreakaway(probeScriptPath);
  if (run.harnessError !== null) {
    if (isBreakawayAccessDenied(run.harnessError)) {
      return "denied";
    }
    throw new Error(
      `breakaway capability probe's own launch harness failed unexpectedly: ${run.harnessError}`,
    );
  }
  // The probe script never calls `exit` itself (both its try and catch
  // branches fall through after writing the marker), so a non-zero or
  // missing exit code here means the launched PowerShell process failed in
  // some way the harness didn't already classify as `harnessError` - trust
  // nothing it wrote in that case; a marker written before an unexpected
  // crash could still look valid on its own.
  if (run.exitCode !== 0) {
    throw new Error(
      `breakaway capability probe's script exited with an unexpected code: ${run.exitCode}`,
    );
  }
  if (!existsSync(markerPath)) {
    throw new Error(
      "breakaway capability probe produced no marker - the probe script itself must have failed before reaching either write",
    );
  }
  const reading = readFileSync(markerPath, "utf8").trim();
  if (reading === "job-free" || reading === "in-job") {
    return reading;
  }
  throw new Error(
    `breakaway capability probe produced an unexpected result: ${JSON.stringify(reading)}`,
  );
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
      "arms through the real launcher under a purely CJK TEMP path - a job-check failure here would be the exact silent Add-Type/csc-under-CJK-TEMP failure this fix eliminates",
      async () => {
        // A dedicated, CJK-only TEMP directory (no apostrophe, no Latin
        // diacritic - isolated from the other odd-path test above) so a
        // failure here can only be attributed to the CJK characters
        // themselves. Historically `Add-Type` shells out to csc.exe, which
        // writes compiler temp files under this exact path and throws a
        // Win32Exception before the launcher/helper's own logic ever runs -
        // that would surface here as a `job-check-failed`/`launcher-failed`
        // (or no marker at all) refusal.
        //
        // Before touching the real launcher at all, `probeBreakawayCapability`
        // INDEPENDENTLY MEASURES whether a breakaway child of this exact
        // process tree can actually escape its job right now, under this same
        // CJK TEMP path - rather than trusting the real call's own
        // self-reported refusal reason. When that measurement proves the
        // runner's job chain is job-free, a refusal from the real call could
        // only be the CJK-triggered native-binding failure this fix
        // eliminates, so `armed` is REQUIRED, full stop - `.not-armed` for
        // ANY reason is a hard failure in that branch, not merely an
        // unaccepted one. Only when the measurement itself proves the runner
        // cannot break away, or lands job-confined, is a fixed job-policy
        // refusal from the real call acceptable.
        const cjkDir = join(workRoot, "日本語のテンプディレクトリ");
        mkdirSync(cjkDir, { recursive: true });
        pointTempAt(cjkDir);

        const capability = probeBreakawayCapability(cjkDir);
        process.stdout.write(
          `[finalize-helper launch test] measured breakaway capability under CJK TEMP: ${capability}\n`,
        );

        const {
          scheduleFinalizationHelper,
          defaultSpawnImpl,
          defaultWriteImpl,
          defaultHelperArmWaitDeps,
        } = await loadHelper();
        let survivedPath = "";
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(cjkDir, "staged.exe"),
          livePath: join(cjkDir, "live.exe"),
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

        if (capability === "job-free") {
          process.stdout.write(
            "[finalize-helper launch test] branch: CJK TEMP - measured job-free, armed is required\n",
          );
          expect(result.status).toBe("armed");
        } else {
          process.stdout.write(
            `[finalize-helper launch test] branch: CJK TEMP - measured ${capability}, a fixed job-policy refusal is acceptable\n`,
          );
          assertArmsUnlessJobPolicyRefused(result);
        }
        if (result.status !== "armed") return;
        expect(existsSync(result.armedPath ?? "")).toBe(true);
        if (result.helperPid !== null) {
          helperPids.push(result.helperPid);
          expect(probeIsProcessInJob(result.helperPid)).toBe(false);
        }
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
          simulateBrokenNestedValueTypeAssignment: false,
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
    // that the broken nested-value-type assignment (reproduced for real
    // against a small Reflection.Emit value-type pair - see
    // `runCommandUnderNoBreakawayJob`'s doc comment) reads back LimitFlags=0,
    // not 0x2000 - the job it creates isn't actually KILL_ON_JOB_CLOSE at
    // all, which would make the "never arms" control above pass for the
    // wrong reason (or not at all) without anyone noticing. Deliberately
    // reproducing that bug here and asserting the read-back gate catches it
    // BEFORE any child is ever launched is the red-first evidence that the
    // gate does its job.
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
          simulateBrokenNestedValueTypeAssignment: true,
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
          simulateBrokenNestedValueTypeAssignment: false,
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

      // `isBreakawayAccessDenied` is now a module-level helper (moved next
      // to `runScriptWithBreakaway`, which it exists to interpret) since
      // `probeBreakawayCapability` needs it too. That is the same safe
      // outcome the production guard exists to guarantee - nothing armed,
      // nothing finalized - so it is accepted here too, logged rather than
      // skipped, in place of the abandoned-vs-finalize assertions this
      // describe block otherwise exists to check (which need a helper that
      // actually got to run at all).

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
      // `notArmedReason` here would let a pre-guard PowerShell crash - the
      // native-binding emission itself throwing, a typo before the job
      // check even runs - masquerade as "the job refusal worked as
      // designed", when it is
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
