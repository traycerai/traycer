import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";
import { clearPendingUpgrade, readCliManifest } from "../manifest/cli-manifest";
import type { Environment } from "../runner/environment";
import { isErrnoException } from "../runner/errors";
import {
  cliPostFinalizeMarkerPath,
  ensureCliInstallHomeDir,
} from "../store/paths";

// Pending CLI upgrade finalize - detached helper path.
//
// `traycer cli upgrade` stages a new CLI binary on disk and records
// `pendingUpgrade` in the install manifest when it can't atomically
// replace the live binary (Windows: the live `.exe` is held open by
// the current CLI process or its supervisor; cross-platform: the
// install dir is read-only). `traycer host restart` then tries to
// finalise the swap in-process between service stop and service start.
//
// That in-process attempt is sufficient on POSIX, where rename
// succeeds even on an open file. On Windows the *current* CLI process
// that's running `host restart` is itself running from the live
// .exe, so even after the host supervisor releases its lock the
// MoveFileEx in renameSync fails with EBUSY. We can't release that
// lock without exiting the CLI process.
//
// The detached helper closes that gap:
//
//   1. The CLI writes a short PowerShell (Windows) or POSIX shell
//      script to a temp path, with the parent CLI's pid baked in, and
//      launches it so that it outlives the CLI (see "Launching on
//      Windows" below for why that is not a detached spawn there).
//   2. On Windows the script first proves it is outside every job object,
//      then writes an "armed" sentinel beside it. The CLI waits up to
//      `HELPER_ARM_WAIT_MS` for that file and reports `armed` only once it
//      exists: the one outcome on which `host restart` leaves the service
//      start to the helper. Anything else is
//      `failed`, and the restart relaunches the host itself - a helper
//      that never ran must not leave the host stopped. A failure after
//      the launch also writes an "abandoned" file the script checks
//      before acting, so a helper that armed too late cannot finalize
//      behind that relaunch.
//   3. The CLI returns its result to the caller and exits, releasing its
//      lock on the live binary.
//   4. The helper polls the parent pid (sub-second). Once the CLI
//      process is gone it hands off to the STAGED binary's own hidden
//      `cli finalize-upgrade` command (`commands/cli-finalize-upgrade.ts`)
//      rather than swapping the binary and starting the service itself.
//      The staged binary is a complete, independently-runnable
//      executable distinct from the live path being replaced, so
//      invoking it gives the swap its own PID + start-time identity to
//      acquire the SAME `cli-lock` every other actor uses (Host Update
//      Layer Redesign Tech Plan, "Windows CLI-finalize helper") -
//      reimplementing the lock's breaking-arbitration protocol in raw
//      PowerShell/shell would duplicate correctness-critical logic with
//      no way to test it. The swap + service start can therefore never
//      race another actor's apply/install/activation critical section.
//   5. `cli finalize-upgrade` writes a marker file at
//      `~/.traycer/cli/post-finalize.json` describing the outcome
//      (swapped / swap-failed), or writes nothing if it timed out
//      waiting for the lock - `pendingUpgrade` stays populated in that
//      case, so the next `host restart` retries the whole flow. The
//      wrapping script writes its own "parent-still-alive" marker
//      directly (the staged binary is never invoked in that case).
//   6. The next CLI invocation - Doctor, `host restart`, etc. -
//      calls `reconcilePostFinalizeMarker(environment)`, which folds the
//      marker into the install manifest (clearing pendingUpgrade and
//      updating version on success) and deletes the marker.
//
// Fail-safe: if the helper cannot complete (the script never arms, the
// swap fails, the lock times out, the OS service start fails), the
// marker either isn't written or records "swap-failed", and
// `pendingUpgrade` stays populated. Doctor continues to emit
// `CLI_UPGRADE_PENDING` and Settings/Doctor surface it via the existing
// card.
//
// Launching on Windows. `spawn(..., { detached: true })` there is
// DETACHED_PROCESS (libuv v1.52.1, the version Node 24.20 bundles,
// `src/win/process.c:1052-1064`): PowerShell starts with no console and
// exits 0 without running a line of the script. That was measured on
// Windows Server 2022 from node and bun, over ssh and in the console
// session, and it is why this helper used to never run. So the CLI
// spawns a NON-detached `powershell.exe` launcher and awaits it. The
// launcher calls CreateProcessW with CREATE_BREAKAWAY_FROM_JOB |
// CREATE_NO_WINDOW on the helper script:
//
//  - The launcher runs without a console window (`windowsHide` with no
//    inherited stdio is CREATE_NO_WINDOW, `process.c:1034-1043`). The
//    helper also uses CREATE_NO_WINDOW; neither process inherits the
//    CLI's stdio handles.
//  - libuv assigns the launcher to a kill-on-close job
//    (`process.c:1082-1100`), and an outer supervisor may assign the CLI
//    to another. Win32-OpenSSH, for example, puts an exec-mode session in
//    a KILL_ON_JOB_CLOSE | BREAKAWAY_OK job. SILENT_BREAKAWAY_OK on libuv's
//    job alone does not release the helper from that outer ssh job.
//    Explicit breakaway requests escape from each permitting job in the
//    chain. Before writing `armed`, the helper checks IsProcessInJob with
//    a NULL job handle, which tests membership in ANY job. If it remains
//    in a job or the check fails, it writes a fixed `.not-armed` reason
//    and exits. The CLI then relaunches the host with the upgrade pending.
//  - The launcher's own script travels as `-EncodedCommand` (UTF-16LE,
//    base64), so the CLI never quotes a path on its command line. The
//    helper path inside it is a PowerShell single-quoted literal before
//    the launcher passes it as a quoted argument to CreateProcessW.
//  - Its stdio is ignored, never piped. A helper that inherited a pipe
//    would hold it open, and the CLI could not exit until the helper did
//    - while the helper waits for the CLI to exit.
//  - The `.ps1` starts with a UTF-8 BOM. Windows PowerShell 5.1 reads a
//    BOM-less `-File` script in the ANSI code page, which garbles a
//    non-ASCII path before its quoting matters.

export interface ScheduleHelperOptions {
  readonly environment: Environment;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  // pid of the current CLI process. The helper waits for this pid to
  // exit before attempting the binary swap.
  readonly parentPid: number;
  // Maximum seconds the helper will wait for parent exit before giving
  // up and writing a "parent-still-alive" marker.
  readonly parentExitTimeoutSeconds: number;
  // Platform the helper script targets. Threaded through explicitly
  // (instead of reading os.platform()) so tests can validate the
  // Windows code path from a POSIX dev machine.
  readonly platform: NodeJS.Platform;
  // Test seam - replace the actual spawn() / writeFileSync() calls
  // with stubs that record arguments instead of touching the OS.
  readonly spawnImpl: SpawnImpl;
  readonly writeImpl: WriteImpl;
  // The clock the wait for the armed sentinel runs on. Tests pass a fake
  // one, so the bound is proven without being waited out.
  readonly armWait: HelperArmWaitDeps;
}

// Narrow surface of `child_process.spawn` we use. Tests substitute a
// stub that records the spawn call without launching anything.
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

export interface SpawnedProcess {
  readonly pid: number | undefined;
  unref: () => void;
  kill: () => void;
  // Settles once the process has exited or failed to start; never
  // rejects. Only the Windows launcher is awaited - the POSIX helper IS
  // the spawned process, and is left running.
  readonly exited: Promise<SpawnedProcessExit>;
}

export interface SpawnedProcessExit {
  // null when the process never started or was killed by a signal.
  readonly exitCode: number | null;
  // Why there is no exit code: the start error, or the signal.
  readonly errorMessage: string | null;
}

export type WriteImpl = (path: string, body: string) => Promise<void>;

export interface HelperArmWaitDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}

// On the Windows review VM, six Node -> launcher -> breakaway runs with a
// stand-in child that compiles the same job check and calls IsProcessInJob
// reached its marker in 687.51-718.77 ms (15.6 ms clock resolution).
// Keep the 10 s bound for slow PowerShell starts under antivirus, while a
// helper that never runs still brings the host back in seconds.
// The whole wait runs with the host stopped and the CLI lock held.
export const HELPER_ARM_WAIT_MS = 10_000;

export const defaultHelperArmWaitDeps: HelperArmWaitDeps = {
  // Monotonic, not `Date.now()`: a wall-clock correction during the wait
  // would stretch it by the size of the correction, with the host stopped
  // and the CLI lock held.
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  waitMs: HELPER_ARM_WAIT_MS,
  pollIntervalMs: 100,
};

export interface ScheduleHelperResult {
  // `armed`: the helper script proved it is outside every job, wrote the
  // sentinel, and owns the swap and the service start from here.
  // `failed`: no running helper could be confirmed, so the caller still
  // owns the service start.
  readonly status: "armed" | "skipped" | "failed";
  readonly platform: NodeJS.Platform;
  readonly scriptPath: string | null;
  // The sentinel the script writes only after it has escaped every job.
  readonly armedPath: string | null;
  readonly markerPath: string;
  // The helper script's own pid, as it wrote it into the sentinel.
  readonly helperPid: number | null;
  readonly errorMessage: string | null;
}

// Real implementations used by `host restart` in production. Exposed
// for tests that want to round-trip a real helper invocation; the
// scheduling tests substitute their own.
export const defaultSpawnImpl: SpawnImpl = (command, args, options) => {
  const child = spawn(command, [...args], options);
  const exited = new Promise<SpawnedProcessExit>((resolve) => {
    // A start failure (ENOENT for a missing powershell.exe) arrives as an
    // `error` event, never a throw, and an unlistened one crashes the
    // CLI. `on`, not `once`: a later `kill` can emit one too.
    child.on("error", (err) => {
      resolve({ exitCode: null, errorMessage: err.message });
    });
    child.once("exit", (code, signal) => {
      resolve({
        exitCode: code,
        errorMessage: signal === null ? null : `killed by ${signal}`,
      });
    });
  });
  return {
    pid: child.pid,
    unref: () => child.unref(),
    kill: () => {
      child.kill();
    },
    exited,
  };
};

export const defaultWriteImpl: WriteImpl = async (path, body) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { encoding: "utf8", mode: 0o700 });
};

// Schedule the helper and wait for it to arm. Returns a structured result
// so the host-restart command can surface the outcome in its NDJSON
// payload without throwing on best-effort failures. Throws only for
// programmer errors (e.g. an unsupported platform reached this path).
export async function scheduleFinalizationHelper(
  opts: ScheduleHelperOptions,
): Promise<ScheduleHelperResult> {
  const platform = opts.platform;
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  // Remove any stale marker from a prior helper attempt so the next
  // reconcile reads only the fresh outcome.
  try {
    await unlink(markerPath);
  } catch {
    // best-effort; absent file is fine
  }
  await ensureCliInstallHomeDir(opts.environment);

  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") {
    return {
      status: "skipped",
      platform,
      scriptPath: null,
      armedPath: null,
      markerPath,
      helperPid: null,
      errorMessage: `finalize helper does not support platform '${platform}'`,
    };
  }

  const files = makeHelperFilePaths(opts.environment, platform);
  const scriptBody =
    platform === "win32"
      ? renderWindowsHelperScript({
          parentPid: opts.parentPid,
          stagedBinaryPath: opts.stagedBinaryPath,
          livePath: opts.livePath,
          markerPath,
          armedPath: files.armedPath,
          notArmedPath: files.notArmedPath,
          abandonedPath: files.abandonedPath,
          timeoutSeconds: opts.parentExitTimeoutSeconds,
        })
      : renderPosixHelperScript({
          parentPid: opts.parentPid,
          stagedBinaryPath: opts.stagedBinaryPath,
          livePath: opts.livePath,
          markerPath,
          armedPath: files.armedPath,
          abandonedPath: files.abandonedPath,
          timeoutSeconds: opts.parentExitTimeoutSeconds,
        });
  const failed = (errorMessage: string): ScheduleHelperResult => ({
    status: "failed",
    platform,
    scriptPath: files.scriptPath,
    armedPath: files.armedPath,
    markerPath,
    helperPid: null,
    errorMessage,
  });

  try {
    await opts.writeImpl(files.scriptPath, scriptBody);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }

  const spawnDescriptor = buildSpawnDescriptor({
    platform,
    scriptPath: files.scriptPath,
    notArmedPath: files.notArmedPath,
  });
  let launched: SpawnedProcess;
  try {
    launched = opts.spawnImpl(
      spawnDescriptor.command,
      spawnDescriptor.args,
      spawnDescriptor.options,
    );
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }

  const armed = await awaitHelperArmed({
    platform,
    launched,
    armedPath: files.armedPath,
    notArmedPath: files.notArmedPath,
    wait: opts.armWait,
  });
  if (armed.status === "armed") {
    return {
      status: "armed",
      platform,
      scriptPath: files.scriptPath,
      armedPath: files.armedPath,
      markerPath,
      helperPid: armed.helperPid,
      errorMessage: null,
    };
  }
  // The caller now relaunches the host itself. A helper that arms after
  // this point must not also finalize behind that relaunch: the script
  // checks for this file once the CLI has exited, by which time it is
  // written. Best-effort - if it cannot be written, a late helper runs
  // `cli finalize-upgrade` beside a running host, which only defers the
  // swap again.
  try {
    await opts.writeImpl(files.abandonedPath, "");
  } catch {
    // best-effort, see above
  }
  return failed(armed.errorMessage ?? "the finalize helper did not arm");
}

// Wait, within one `wait.waitMs` budget, for the launcher to exit (Windows
// only) and then for the helper to write `armedPath` or `notArmedPath`.
async function awaitHelperArmed(opts: {
  readonly platform: NodeJS.Platform;
  readonly launched: SpawnedProcess;
  readonly armedPath: string;
  readonly notArmedPath: string;
  readonly wait: HelperArmWaitDeps;
}): Promise<
  Pick<ScheduleHelperResult, "status" | "helperPid" | "errorMessage">
> {
  const { launched, wait } = opts;
  const deadline = wait.now() + wait.waitMs;
  if (opts.platform === "win32") {
    // Awaited: the launcher exits as soon as CreateProcessW returns. A
    // non-zero exit means the helper could not be created.
    const launcher: { exit: SpawnedProcessExit | null } = { exit: null };
    void launched.exited.then((exit) => {
      launcher.exit = exit;
    });
    while (launcher.exit === null) {
      if (wait.now() >= deadline) {
        // A ref'd child would also hold this CLI open.
        launched.kill();
        return {
          status: "failed",
          helperPid: null,
          errorMessage: `the finalize helper launcher did not exit within ${wait.waitMs} ms`,
        };
      }
      await wait.sleep(wait.pollIntervalMs);
    }
    if (launcher.exit.exitCode !== 0) {
      const reason = await readNotArmedReason(opts.notArmedPath);
      return {
        status: "failed",
        helperPid: null,
        errorMessage: `the finalize helper launcher failed (${
          reason ??
          launcher.exit.errorMessage ??
          `exit code ${launcher.exit.exitCode}`
        })`,
      };
    }
  } else {
    // The detached `/bin/sh` is the helper itself.
    launched.unref();
  }
  for (;;) {
    if (opts.platform === "win32") {
      const reason = await readNotArmedReason(opts.notArmedPath);
      if (reason !== null) {
        return {
          status: "failed",
          helperPid: null,
          errorMessage: `the finalize helper did not arm (${reason})`,
        };
      }
    }
    const sentinel = await readArmedSentinel(opts.armedPath);
    if (sentinel.armed) {
      return { status: "armed", helperPid: sentinel.pid, errorMessage: null };
    }
    if (wait.now() >= deadline) {
      return {
        status: "failed",
        helperPid: null,
        errorMessage: `the finalize helper did not start within ${wait.waitMs} ms`,
      };
    }
    await wait.sleep(wait.pollIntervalMs);
  }
}

type NotArmedReason =
  | "in-job"
  | "job-check-failed"
  | "create-denied"
  | "create-failed"
  | "unrecognized-refusal";

// The helper and launcher write only these fixed reason codes. Treat any
// other contents as an unrecognized refusal, never echoing a temp-file
// payload into the restart result.
async function readNotArmedReason(
  path: string,
): Promise<NotArmedReason | null> {
  let reason: string;
  try {
    reason = (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
  if (
    reason === "in-job" ||
    reason === "job-check-failed" ||
    reason === "create-denied" ||
    reason === "create-failed"
  ) {
    return reason;
  }
  return "unrecognized-refusal";
}

// On Windows the sentinel exists only after the helper proved it is
// outside every job. Its pid is best-effort: the CLI can read the file
// between its creation and the write. Any read error counts as "not yet";
// the deadline bounds that.
async function readArmedSentinel(
  armedPath: string,
): Promise<
  | { readonly armed: false }
  | { readonly armed: true; readonly pid: number | null }
> {
  let text: string;
  try {
    text = await readFile(armedPath, "utf8");
  } catch {
    return { armed: false };
  }
  const pid = Number.parseInt(text.trim(), 10);
  return {
    armed: true,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
  };
}

// The script and its sidecar files, side by side:
// `<stem>.ps1` (or `.sh`), `<stem>.armed`, `<stem>.not-armed`,
// `<stem>.abandoned`.
function makeHelperFilePaths(
  environment: Environment,
  platform: NodeJS.Platform,
): {
  readonly scriptPath: string;
  readonly armedPath: string;
  readonly notArmedPath: string;
  readonly abandonedPath: string;
} {
  const ext = platform === "win32" ? ".ps1" : ".sh";
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const stem = join(tmpdir(), `traycer-cli-finalize-${environment}-${stamp}`);
  return {
    scriptPath: `${stem}${ext}`,
    armedPath: `${stem}.armed`,
    notArmedPath: `${stem}.not-armed`,
    abandonedPath: `${stem}.abandoned`,
  };
}

function buildSpawnDescriptor(opts: {
  readonly platform: NodeJS.Platform;
  readonly scriptPath: string;
  readonly notArmedPath: string;
}): {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
} {
  if (opts.platform === "win32") {
    // Never `detached`: see "Launching on Windows" at the top of this file.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellCommand(
          renderWindowsLauncherScript(opts.scriptPath, opts.notArmedPath),
        ),
      ],
      options: {
        detached: false,
        stdio: "ignore",
        windowsHide: true,
        // Inherit env so PATH-based PowerShell resolution works.
        env: process.env,
      },
    };
  }
  return {
    command: "/bin/sh",
    args: [opts.scriptPath],
    options: {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  };
}

// Add-Type compiles this in the short-lived launcher. CreateProcessW is
// needed because Start-Process does not request breakaway from an outer job
// (notably an ssh session's kill-on-close job). The STARTUPINFO layout is
// the documented Win32 layout on both 32- and 64-bit Windows.
const WINDOWS_CREATE_PROCESS_TYPE = `using System;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct TraycerStartupInfo {
    public uint cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
}

[StructLayout(LayoutKind.Sequential)]
public struct TraycerProcessInformation {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
}

public static class TraycerCreateProcess {
    public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    public const uint CREATE_NO_WINDOW = 0x08000000;

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessNative(
        string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, IntPtr currentDirectory,
        ref TraycerStartupInfo startupInfo,
        out TraycerProcessInformation processInformation);

    public static bool TryCreateProcess(
        string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags, IntPtr environment, IntPtr currentDirectory,
        ref TraycerStartupInfo startupInfo,
        out TraycerProcessInformation processInformation,
        out int win32Error) {
        bool created = CreateProcessNative(
            applicationName, commandLine, processAttributes,
            threadAttributes, inheritHandles, creationFlags, environment,
            currentDirectory, ref startupInfo, out processInformation);
        win32Error = created ? 0 : Marshal.GetLastWin32Error();
        return created;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}`;

// The Windows launcher's whole script. `Join-Path $PSHOME` starts the
// helper under the same Windows PowerShell as the launcher. The encoded
// launcher is the only command-line argument the CLI constructs; the
// helper path becomes a quoted UTF-16 argument inside it. Windows paths
// cannot contain a double quote.
function renderWindowsLauncherScript(
  scriptPath: string,
  notArmedPath: string,
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    WINDOWS_CREATE_PROCESS_TYPE,
    "'@",
    "$powershellExe = Join-Path $PSHOME 'powershell.exe'",
    `$commandLine = [System.Text.StringBuilder]::new('"' + $powershellExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ${psString(scriptPath)} + '"')`,
    `$notArmedPath = ${psString(notArmedPath)}`,
    "$startupInfo = [TraycerStartupInfo]::new()",
    "$startupInfo.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($startupInfo)",
    "$processInfo = [TraycerProcessInformation]::new()",
    "$createError = 0",
    "$flags = [uint32]([TraycerCreateProcess]::CREATE_BREAKAWAY_FROM_JOB -bor [TraycerCreateProcess]::CREATE_NO_WINDOW)",
    "$created = [TraycerCreateProcess]::TryCreateProcess($powershellExe, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$startupInfo, [ref]$processInfo, [ref]$createError)",
    "if (-not $created) {",
    "  $reason = if ($createError -eq 5) { 'create-denied' } else { 'create-failed' }",
    "  [System.IO.File]::WriteAllText($notArmedPath, $reason)",
    "  exit 1",
    "}",
    "[TraycerCreateProcess]::CloseHandle($processInfo.hThread) | Out-Null",
    "[TraycerCreateProcess]::CloseHandle($processInfo.hProcess) | Out-Null",
    "exit 0",
  ].join("\n");
}

// `powershell.exe -EncodedCommand` takes base64 of the script's UTF-16LE
// bytes.
function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const UTF8_BOM = "\uFEFF";

// IsProcessInJob with a NULL job handle tests membership in any job,
// including a nested outer job inherited after the breakaway request.
const WINDOWS_JOB_CHECK_TYPE = `using System;
using System.Runtime.InteropServices;

public static class TraycerJobCheck {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(
        IntPtr processHandle, IntPtr jobHandle,
        [MarshalAs(UnmanagedType.Bool)] out bool inJob);
}`;

// PowerShell helper. Polls `Get-Process -Id <pid>` until the parent CLI
// exits, then hands off the binary swap + service start to the staged
// CLI's own hidden `cli finalize-upgrade` command - see the module doc
// comment above for why (own PID + start-time identity for the cli-lock
// acquisition).
//
// Starts with a UTF-8 BOM, then checks all job membership before arming:
// a helper that will die with a job cannot take over the service start.
function renderWindowsHelperScript(opts: {
  readonly parentPid: number;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly markerPath: string;
  readonly armedPath: string;
  readonly notArmedPath: string;
  readonly abandonedPath: string;
  readonly timeoutSeconds: number;
}): string {
  return `${UTF8_BOM}$ErrorActionPreference = 'Stop'
$NotArmedPath = ${psString(opts.notArmedPath)}
try {
  Add-Type -TypeDefinition @'
${WINDOWS_JOB_CHECK_TYPE}
'@
  $inJob = $false
  if (-not [TraycerJobCheck]::IsProcessInJob([TraycerJobCheck]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)) {
    [System.IO.File]::WriteAllText($NotArmedPath, 'job-check-failed')
    exit 1
  }
  if ($inJob) {
    [System.IO.File]::WriteAllText($NotArmedPath, 'in-job')
    exit 0
  }
} catch {
  [System.IO.File]::WriteAllText($NotArmedPath, 'job-check-failed')
  exit 1
}
[System.IO.File]::WriteAllText(${psString(opts.armedPath)}, [string]$PID)
# END ARM GUARD
# traycer-cli pending-upgrade finalize helper (Windows). Only a helper
# outside every job owns the service start; otherwise the CLI relaunches.
$ErrorActionPreference = "Continue"
$ParentPid = ${opts.parentPid}
$StagedBinary = ${psString(opts.stagedBinaryPath)}
$LiveBinary = ${psString(opts.livePath)}
$MarkerPath = ${psString(opts.markerPath)}
$AbandonedPath = ${psString(opts.abandonedPath)}
$TimeoutSec = ${opts.timeoutSeconds}

function Write-Marker([hashtable]$Payload) {
  $Payload["attemptedAt"] = (Get-Date).ToUniversalTime().ToString("o")
  $Payload["livePath"] = $LiveBinary
  $Payload["stagedBinaryPath"] = $StagedBinary
  $json = $Payload | ConvertTo-Json -Depth 6
  $dir = Split-Path -Parent $MarkerPath
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tmp = "$MarkerPath.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -Force -LiteralPath $tmp -Destination $MarkerPath
}

# 1. Wait for parent CLI process to exit.
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
# 2. The CLI stopped waiting for this script to arm and relaunched the
# host itself; finalizing now would race that. pendingUpgrade stays, so
# the next 'host restart' retries.
if (Test-Path -LiteralPath $AbandonedPath) { exit 0 }
if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  Write-Marker @{
    status = "parent-still-alive";
    errorMessage = "parent CLI process $ParentPid did not exit within $TimeoutSec seconds";
  }
  exit 0
}

# 3. Hand off the binary swap + service start to the staged CLI's own
# hidden 'cli finalize-upgrade' command. It acquires the cli-lock under
# its own process identity (this invocation's PID + start time), swaps
# the binary, starts the service, and writes its own post-finalize
# marker (or writes nothing and defers to the next 'host restart' if
# the lock acquisition times out) - this script's job ends here.
& $StagedBinary cli finalize-upgrade *> $null
exit 0
`;
}

function psString(value: string): string {
  return powershellSingleQuoted(value);
}

// POSIX helper. We don't strictly need a detached helper on POSIX
// (rename succeeds on open files there), but the same shape is
// useful for read-only-install cases and lets test rigs exercise
// the marker reconciler on a POSIX dev machine. Once the parent CLI
// exits, the binary swap + service start hand off to the staged CLI's
// own hidden `cli finalize-upgrade` command - see the module doc
// comment above for why (own PID + start-time identity for the
// cli-lock acquisition).
function renderPosixHelperScript(opts: {
  readonly parentPid: number;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly markerPath: string;
  readonly armedPath: string;
  readonly abandonedPath: string;
  readonly timeoutSeconds: number;
}): string {
  return `#!/usr/bin/env sh
printf '%s' "$$" > ${shString(opts.armedPath)}
# traycer-cli pending-upgrade finalize helper (POSIX). The line above runs
# first, for the same reason as in the Windows script.
set -u
PARENT_PID=${shString(String(opts.parentPid))}
STAGED=${shString(opts.stagedBinaryPath)}
LIVE=${shString(opts.livePath)}
MARKER=${shString(opts.markerPath)}
ABANDONED=${shString(opts.abandonedPath)}
TIMEOUT=${shString(String(opts.timeoutSeconds))}

# JSON construction for the parent-still-alive marker: prefer python3
# (universally available on standard macOS / Linux release runners,
# including hosted GitHub runners) so trusted-comment edge characters
# in STAGED / LIVE never produce a malformed marker. Falls back to a
# strict-escape printf path that rejects \\b\\f\\r and replaces
# \\ " \\n \\t per RFC 8259 §7.
write_marker() {
  status="$1"; errmsg="$2"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$MARKER")"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.dumps({"status":sys.argv[1],"attemptedAt":sys.argv[2],"livePath":sys.argv[3],"stagedBinaryPath":sys.argv[4],"errorMessage":(sys.argv[5] or None),"serviceStartError":None}))' \\
      "$status" "$ts" "$LIVE" "$STAGED" "$errmsg" > "$MARKER.tmp"
  else
    safe_status="$(strict_escape "$status")"
    safe_ts="$(strict_escape "$ts")"
    safe_live="$(strict_escape "$LIVE")"
    safe_staged="$(strict_escape "$STAGED")"
    safe_err="$(json_str "$errmsg")"
    printf '{"status":"%s","attemptedAt":"%s","livePath":"%s","stagedBinaryPath":"%s","errorMessage":%s,"serviceStartError":null}\\n' \\
      "$safe_status" "$safe_ts" "$safe_live" "$safe_staged" "$safe_err" > "$MARKER.tmp"
  fi
  mv -f "$MARKER.tmp" "$MARKER"
}

# Escape backslash, double-quote, newline, tab. Anything else passes
# through. Sufficient for the absolute filesystem paths the helper sees
# in practice.
strict_escape() {
  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e ':a;N;$!ba;s/\\n/\\\\n/g' -e 's/\\t/\\\\t/g'
}

json_str() {
  if [ -z "$1" ]; then
    printf 'null'
  else
    printf '"%s"' "$(strict_escape "$1")"
  fi
}

deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$PARENT_PID" 2>/dev/null; then break; fi
  sleep 1
done
# The CLI stopped waiting for this script to arm; see the Windows script.
if [ -e "$ABANDONED" ]; then exit 0; fi
if kill -0 "$PARENT_PID" 2>/dev/null; then
  write_marker "parent-still-alive" "parent CLI process $PARENT_PID did not exit within $TIMEOUT seconds"
  exit 0
fi

# Hand off the binary swap + service start to the staged CLI's own
# hidden 'cli finalize-upgrade' command. It acquires the cli-lock under
# its own process identity (this invocation's PID + start time), swaps
# the binary, starts the service, and writes its own post-finalize
# marker (or writes nothing and defers to the next 'host restart' if
# the lock acquisition times out) - this script's job ends here.
"$STAGED" cli finalize-upgrade >/dev/null 2>&1
exit 0
`;
}

function shString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type PostFinalizeMarkerStatus =
  | "swapped"
  | "swap-failed"
  | "parent-still-alive";

export interface PostFinalizeMarker {
  readonly status: PostFinalizeMarkerStatus;
  readonly attemptedAt: string;
  readonly livePath: string;
  readonly stagedBinaryPath: string;
  readonly errorMessage: string | null;
  readonly serviceStartError: string | null;
}

function isPostFinalizeMarker(value: unknown): value is PostFinalizeMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (
    obj.status !== "swapped" &&
    obj.status !== "swap-failed" &&
    obj.status !== "parent-still-alive"
  ) {
    return false;
  }
  if (typeof obj.attemptedAt !== "string") return false;
  if (typeof obj.livePath !== "string") return false;
  if (typeof obj.stagedBinaryPath !== "string") return false;
  if (obj.errorMessage !== null && typeof obj.errorMessage !== "string") {
    return false;
  }
  if (
    obj.serviceStartError !== null &&
    obj.serviceStartError !== undefined &&
    typeof obj.serviceStartError !== "string"
  ) {
    return false;
  }
  return true;
}

// Narrow a validated payload to the declared `PostFinalizeMarker`, collapsing
// an OMITTED `serviceStartError` to `null`.
//
// The validator above deliberately accepts the field being absent, because
// legacy markers (and the Windows helper's `parent-still-alive` branch) never
// wrote it. That tolerance quietly made the type a lie: the interface says
// `string | null`, so every reader is entitled to test `=== null` for "no
// error", and an `undefined` slipping through fails that test. Doctor's
// `swapped` card did exactly that and rendered "the helper could not start
// the host service afterwards: undefined" for a perfectly clean legacy
// marker. `reconcilePostFinalizeMarker` had been papering over the same gap
// with `?? null` at each use site; normalising once, here, means no future
// reader has to remember.
function toPostFinalizeMarker(value: PostFinalizeMarker): PostFinalizeMarker {
  return { ...value, serviceStartError: value.serviceStartError ?? null };
}

// What a read-only caller learns from the post-finalize marker.
// `"absent"` and `"invalid"` are kept distinct because they license
// different statements: absent means the helper wrote nothing (it never
// ran, or it is still running), while invalid means it wrote something
// this CLI cannot interpret - a fault worth naming rather than silence.
export type PostFinalizeMarkerRead =
  | { readonly status: "absent" }
  // The file was READ but its contents are not a marker (bad JSON, wrong
  // shape). `reconcilePostFinalizeMarker` unlinks this, so a lifecycle command
  // genuinely clears it.
  | { readonly status: "invalid"; readonly errorMessage: string }
  // The file could not be read AT ALL (EACCES, EIO, an unsearchable parent).
  // Split from `invalid` because the two license different advice: nothing in
  // the CLI can clear this one - reconciliation's own `readFile` fails the
  // same way and returns without unlinking - so telling someone to run a
  // lifecycle command would promise a repair that cannot happen. The auth and
  // identity probes in `doctor/engine.ts` draw exactly this line for the same
  // reason (`HOST_AUTH_DIR_INACCESSIBLE`).
  | { readonly status: "unreadable"; readonly errorMessage: string }
  | { readonly status: "present"; readonly marker: PostFinalizeMarker };

// Read the marker WITHOUT consuming it or touching the manifest.
//
// This exists because `reconcilePostFinalizeMarker` below is a mutation, and
// two very different callers wanted the same information. `host restart` is
// entitled to mutate - it is a lifecycle command, and folding the helper's
// outcome into the manifest between stop and start is part of its job.
// `host doctor` is not: a command whose entire contract is "look at the
// machine and tell me what you see" was deleting the marker file and
// rewriting the CLI install manifest as a side effect of being asked a
// question (audit finding CLI-007). A diagnostic that mutates the state it
// diagnoses cannot be run twice and be trusted, and cannot be run at all by
// someone who only wanted to look.
//
// So doctor reads through here and reports what it finds; reconciliation
// stays in `host restart`, which is also the fix doctor points at.
//
// Never throws.
export async function readPostFinalizeMarker(opts: {
  readonly environment: Environment;
}): Promise<PostFinalizeMarkerRead> {
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { status: "absent" };
    }
    // Could not read the bytes - distinct from "read them and they were
    // nonsense". See `PostFinalizeMarkerRead` for why the caller needs these
    // apart.
    return {
      status: "unreadable",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "invalid",
      errorMessage: `marker JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPostFinalizeMarker(parsed)) {
    return {
      status: "invalid",
      errorMessage: "marker payload does not match expected shape",
    };
  }
  return { status: "present", marker: toPostFinalizeMarker(parsed) };
}

// The identity of the operation a marker describes, as far as the marker
// format can express it.
export interface MarkerUpgradeIdentity {
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly stagedAt: string;
}

// Does this marker describe THIS pending upgrade?
//
// Lives here, exported, because two callers need the identical answer and the
// cost of them drifting is concrete rather than theoretical: doctor reporting
// an upgrade as already applied while `host restart` discards the same marker
// as stale was an actual defect in this PR's history, found in review. Two
// copies of the predicate put that one edit away from returning.
//
// Both paths are compared, and the ORDERING too, because neither path is
// identity on its own: `cli re-anchor` deliberately keeps a path across
// binaries, and `cli upgrade` derives the staged filename from the version, so
// a same-version retry reproduces the exact tuple an older marker carries. A
// marker written before the upgrade was staged cannot be describing it.
//
// Timestamps are compared as instants, never as strings: the Windows helper
// writes `(Get-Date).ToUniversalTime().ToString("o")` (7 fractional digits)
// against `toISOString()`'s 3, so lexicographic ordering mis-sorts the same
// moment. An unparseable timestamp answers `false` - the conservative
// direction, which retries an upgrade rather than falsely completing one.
export function markerDescribesUpgrade(
  marker: PostFinalizeMarker,
  pending: MarkerUpgradeIdentity,
): boolean {
  if (marker.stagedBinaryPath !== pending.stagedBinaryPath) return false;
  if (marker.livePath !== pending.livePath) return false;
  const markerAt = Date.parse(marker.attemptedAt);
  const stagedAt = Date.parse(pending.stagedAt);
  if (!Number.isFinite(markerAt) || !Number.isFinite(stagedAt)) return false;
  return markerAt >= stagedAt;
}

export type ReconcileOutcome =
  | { readonly status: "no-marker" }
  | { readonly status: "marker-invalid"; readonly errorMessage: string }
  | {
      readonly status: "applied-swapped";
      readonly previousVersion: string;
      readonly version: string;
      readonly serviceStartError: string | null;
    }
  | {
      readonly status: "applied-swap-failed";
      readonly errorMessage: string;
      // Why the host is still stopped, when the finalizer's own attempt
      // to restart the service also failed. The marker is deleted as it
      // is read, so dropping this here would destroy the only durable
      // record of that - leaving the next invocation able to report the
      // failed swap but not the down host it caused.
      readonly serviceStartError: string | null;
    }
  | { readonly status: "applied-parent-still-alive" }
  // The marker on disk describes a DIFFERENT staged upgrade than the one the
  // manifest is currently pending, so it was not evidence about this
  // operation and nothing was applied from it. The marker is removed, because
  // it refers to a swap nobody is waiting on any more.
  | {
      readonly status: "stale-marker-discarded";
      readonly markerStagedBinaryPath: string;
      readonly pendingStagedBinaryPath: string;
      readonly markerLivePath: string;
      readonly manifestBinaryPath: string;
      readonly markerAttemptedAt: string;
      readonly pendingStagedAt: string;
    };

// Read any pending post-finalize marker the detached helper wrote and
// fold its outcome into the CLI install manifest. Idempotent - the
// marker is unlinked after a successful read, so repeated invocations
// are no-ops.
//
// Called ONLY from the host-restart command, to apply marker effects before
// the next stop/start cycle. The Doctor engine used to call it too, so its
// report would reflect the most recent helper outcome - but that made a
// diagnostic delete the marker and rewrite the manifest as a side effect of
// being asked a question (audit finding CLI-007). Doctor now uses the
// read-only `readPostFinalizeMarker` above and reports what it sees, naming
// `traycer host restart` - i.e. this function - as the thing that applies it.
export async function reconcilePostFinalizeMarker(opts: {
  readonly environment: Environment;
}): Promise<ReconcileOutcome> {
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { status: "no-marker" };
    }
    return {
      status: "marker-invalid",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    await safeUnlink(markerPath);
    return {
      status: "marker-invalid",
      errorMessage: `marker JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPostFinalizeMarker(parsed)) {
    await safeUnlink(markerPath);
    return {
      status: "marker-invalid",
      errorMessage: "marker payload does not match expected shape",
    };
  }
  const manifest = await readCliManifest(opts.environment);
  if (manifest === null || manifest.pendingUpgrade === null) {
    // The helper completed but the manifest no longer references a
    // pending upgrade - either another finalize path beat us to it or
    // the manifest was rewritten. Drop the marker either way.
    await safeUnlink(markerPath);
    if (parsed.status === "swapped") {
      // No manifest change to make, but report success so callers can
      // log the outcome.
      return {
        status: "applied-swapped",
        previousVersion: manifest?.version ?? "",
        version: manifest?.version ?? "",
        serviceStartError: parsed.serviceStartError ?? null,
      };
    }
    return parsed.status === "swap-failed"
      ? {
          status: "applied-swap-failed",
          errorMessage: parsed.errorMessage ?? "swap failed (no error message)",
          serviceStartError: parsed.serviceStartError ?? null,
        }
      : { status: "applied-parent-still-alive" };
  }
  const pending = manifest.pendingUpgrade;

  // CORRELATE BEFORE ACTING - this path MUTATES, so getting it wrong is worse
  // here than in doctor's read.
  //
  // A marker names the two paths it operated on and no version, so it is only
  // evidence about the upgrade it was actually written for. Nothing guarantees
  // it was consumed: a helper that swapped 1.5.0 can leave its marker behind,
  // and a later `cli upgrade` then records `pendingUpgrade` 1.6.0 alongside
  // it. The `swapped` branch below would promote 1.6.0 to installed and clear
  // the pending record on the strength of the 1.5.0 marker - stamping the
  // manifest with a version whose staged binary was never swapped onto the
  // live path. The CLI would report itself as 1.6.0 while running 1.5.0
  // bytes, with nothing left on disk to detect it from.
  //
  // Doctor now refuses the same stale marker when reporting (doctor/engine.ts)
  // and routes the user to `traycer host restart` - i.e. straight into this
  // function - so leaving the correlation out on this side would have made the
  // diagnostic a delivery mechanism for the corruption.
  //
  // `stagedBinaryPath` discriminates because `cli upgrade` stamps the target
  // version into the staged filename (`traycer-<version>-<platform>`). A
  // mismatched marker is DISCARDED rather than applied: it describes a
  // completed operation nobody is waiting on, and leaving it would re-pose the
  // same question to every future caller.
  // BOTH paths are compared, not just the staged one. The staged filename
  // carries the version, which defeats the stale-version case - but not the
  // re-anchor one: `cli re-anchor` can repoint `manifest.binaryPath` at a
  // different filename without deleting this marker, and if a SAME-version
  // upgrade then becomes pending, the deterministic staged filename matches
  // the stale marker while its `livePath` still names the old binary.
  // Accepting it there would promote a version whose bytes never reached the
  // re-anchored destination. The marker only describes this operation if it
  // agrees about where the bytes came FROM and where they went TO.
  //
  // Identity is decided by the shared `markerDescribesUpgrade` predicate above
  // rather than inline, so this path and doctor's read path cannot drift - a
  // divergence that already happened once in this PR's history and produced
  // doctor announcing an upgrade as applied while this function correctly
  // discarded the same marker as stale.
  if (
    !markerDescribesUpgrade(parsed, {
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: manifest.binaryPath,
      stagedAt: pending.stagedAt,
    })
  ) {
    await safeUnlink(markerPath);
    return {
      status: "stale-marker-discarded",
      markerStagedBinaryPath: parsed.stagedBinaryPath,
      pendingStagedBinaryPath: pending.stagedBinaryPath,
      markerLivePath: parsed.livePath,
      manifestBinaryPath: manifest.binaryPath,
      markerAttemptedAt: parsed.attemptedAt,
      pendingStagedAt: pending.stagedAt,
    };
  }

  if (parsed.status === "swapped") {
    // The helper completed the swap; promote the manifest's
    // pendingUpgrade.version to the top-level fields and clear
    // pendingUpgrade. Helper has already moved the staged binary
    // onto the live path on disk, so binaryPath stays the same.
    const previousVersion = manifest.version;
    await clearPendingUpgrade(opts.environment, {
      version: pending.version,
      binaryPath: manifest.binaryPath,
      installedAt: new Date().toISOString(),
    });
    await safeUnlink(markerPath);
    return {
      status: "applied-swapped",
      previousVersion,
      version: pending.version,
      serviceStartError: parsed.serviceStartError ?? null,
    };
  }
  if (parsed.status === "swap-failed") {
    // Helper tried and the swap itself failed. Leave pendingUpgrade
    // in place so Doctor still surfaces it; consume the marker.
    // `serviceStartError` rides along because consuming the marker
    // destroys it - and on this path it is the only thing that explains
    // a host that is still down rather than merely un-upgraded.
    await safeUnlink(markerPath);
    return {
      status: "applied-swap-failed",
      errorMessage: parsed.errorMessage ?? "swap failed (no error message)",
      serviceStartError: parsed.serviceStartError ?? null,
    };
  }
  // parent-still-alive - helper gave up waiting. Manifest unchanged.
  await safeUnlink(markerPath);
  return { status: "applied-parent-still-alive" };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort; absent file is fine
  }
}
