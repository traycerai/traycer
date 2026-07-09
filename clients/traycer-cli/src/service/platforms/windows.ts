import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readHostPidMetadata,
  removeHostPidMetadata,
} from "../../host/pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { isProcessAlive } from "../../store/cli-lock";
import type { CliInvocation } from "../cli-binary";
import { escapeXml } from "../escape-xml";
import { windowsTaskName, type ServiceLabel } from "../label";
import { ProcessRunError, runCommand } from "../process-runner";
import { cliInstallHomeDir, hostHomeDir } from "../../store/paths";
import type {
  InstallServiceOptions,
  ServiceController,
  ServiceStatus,
  UninstallServiceOptions,
} from "../index";

// Windows service controller - per-user Scheduled Task. Per the Tech
// Plan we never elevate; if a future change ever needed admin we'd
// fall back to user-only and surface a doctor message rather than
// prompting for UAC.

// Pluggable runner shape kept consistent with macOS so tests can exercise the
// controller without touching schtasks/taskkill.
export type ProcessRunner = typeof runCommand;

export function createWindowsController(
  runner: ProcessRunner | null,
): ServiceController {
  const run = runner ?? runCommand;
  return {
    install: (options) => installService(options),
    uninstall: (options) => uninstallService(options, run),
    status: (label) => statusService(label),
    stop: (label) => stopService(label, run),
    start: (label) => startService(label),
    restart: (label) => restartService(label, run),
  };
}

async function installService(options: InstallServiceOptions): Promise<void> {
  const taskName = windowsTaskName(options.label);
  // schtasks /Create /XML reads the task definition from disk. Stage it inside a
  // private per-invocation directory (mkdtemp ⇒ mode 0700 with an unguessable
  // suffix) rather than a predictable name in the shared tmpdir, so a local
  // attacker can't pre-create or symlink the path we're about to write.
  const tmpDir = await mkdtemp(join(tmpdir(), "traycer-task-"));
  const xmlPath = join(tmpDir, "task.xml");
  // schtasks /Create /XML requires UTF-16 LE with BOM. Anything else
  // fails with "The specified file is not a valid XML file". Node's
  // built-in `utf16le` encoder paired with a leading U+FEFF BOM
  // handles surrogate pairs / non-BMP code points (emoji, etc.) that
  // the hand-rolled writeUInt16LE-per-char loop would corrupt.
  await writeHiddenHostLauncher(options);
  const xmlBody = buildTaskXml({ label: options.label, cli: options.cli });
  await writeFile(xmlPath, Buffer.from(`﻿${xmlBody}`, "utf16le"));
  try {
    await runCommand(
      "schtasks",
      ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 30_000,
        tolerateNonZeroExit: false,
      },
    );
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `schtasks /Create failed for ${taskName}: ${describeCause(cause)}`,
      details: { task: taskName, cause: describeCause(cause) },
      exitCode: 1,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  // Kick the task immediately so the host comes up without waiting
  // for the next logon.
  await runCommand("schtasks", ["/Run", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: false,
  });
}

async function uninstallService(
  options: UninstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  const taskName = windowsTaskName(options.label);
  await run("schtasks", ["/End", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  // Reap the orphaned host tree so the host doesn't keep running (and serving
  // its port) after the task is deleted.
  await killHostProcessTree(options.label, run);
  await run("schtasks", ["/Delete", "/TN", taskName, "/F"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  await rm(hiddenHostLauncherPath(options.label), { force: true });
  // Same rationale as stopService: the force-kill above skips the host's
  // graceful pid.json cleanup, and metadata surviving an uninstall reads as
  // a crashed (rather than removed) host to anything that finds it later.
  await removeHostPidMetadata(options.label.environment);
}

async function statusService(label: ServiceLabel): Promise<ServiceStatus> {
  const taskName = windowsTaskName(label);
  let registered: boolean;
  try {
    await runCommand("schtasks", ["/Query", "/TN", taskName], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
    registered = true;
  } catch (err) {
    if (err instanceof ProcessRunError) {
      registered = false;
    } else {
      throw err;
    }
  }
  if (!registered) {
    return statusNotInstalled();
  }
  const pidMetadata = await readHostPidMetadata(label.environment);
  if (pidMetadata !== null && isProcessAlive(pidMetadata.pid)) {
    return {
      state: "running",
      version: pidMetadata.version,
      listenUrl: pidMetadata.websocketUrl,
      pid: pidMetadata.pid,
    };
  }
  return { state: "stopped", version: null, listenUrl: null, pid: null };
}

async function stopService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  await run("schtasks", ["/End", "/TN", windowsTaskName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  await killHostProcessTree(label, run);
  // The force-kill above never lets the host honor its "remove pid.json on
  // graceful shutdown" contract, and metadata left behind makes this
  // deliberate stop indistinguishable from a crash - the desktop's health
  // watchdog would resurrect the host the user just stopped.
  await removeHostPidMetadata(label.environment);
}

// `schtasks /End` terminates the task's root process but can leave the host's
// child `node` process orphaned - Task Scheduler does not job-object the tree,
// so a wrapper -> node chain survives. A stale host keeps serving its port, and
// (worse) its CWD stays open inside the install dir, so the next install-swap
// rename fails with EBUSY. Kill the processes a slot-scoped scan verifies by
// exe path/command line - that covers the recorded pid.json host too, when it
// is genuinely still the host. The raw recorded pid is used only when the scan
// itself is unavailable: a host that died without cleanup leaves pid.json
// behind, and Windows may have recycled that pid for an unrelated process an
// unverified `taskkill /T /F` would take down.
async function killHostProcessTree(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  const scannedPids = await findSlotProcessIds(label, run);
  const pidMetadata =
    scannedPids === null ? await readHostPidMetadata(label.environment) : null;
  const fallbackPids = pidMetadata === null ? [] : [pidMetadata.pid];
  const pids = uniqueProcessIds(scannedPids ?? fallbackPids);
  await Promise.all(
    pids.map((pid) =>
      run("taskkill", ["/T", "/F", "/PID", String(pid)], {
        env: undefined,
        cwd: undefined,
        timeoutMs: 30_000,
        tolerateNonZeroExit: true,
      }).catch(() => undefined),
    ),
  );
}

async function startService(label: ServiceLabel): Promise<void> {
  try {
    await runCommand("schtasks", ["/Run", "/TN", windowsTaskName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 30_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `schtasks /Run failed for ${windowsTaskName(label)}: ${describeCause(cause)}`,
      details: { task: windowsTaskName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function restartService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  const taskName = windowsTaskName(label);
  await run("schtasks", ["/End", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  // Reap the orphaned host tree before re-running, otherwise the old node keeps
  // its port + install dir and the fresh task races a stale host.
  await killHostProcessTree(label, run);
  try {
    await run("schtasks", ["/Run", "/TN", taskName], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 30_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `schtasks /Run failed for ${taskName}: ${describeCause(cause)}`,
      details: { task: taskName, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

function statusNotInstalled(): ServiceStatus {
  return { state: "not-installed", version: null, listenUrl: null, pid: null };
}

function describeCause(cause: unknown): string {
  if (cause instanceof ProcessRunError) {
    return `${cause.message} (exit=${cause.exitCode})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

// Returns null (rather than an empty list) when the scan could not run at
// all, so the caller can distinguish "verified: nothing to kill" from
// "unknown: PowerShell unavailable".
async function findSlotProcessIds(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<readonly number[] | null> {
  try {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        buildSlotProcessScanScript({
          hostHome: hostHomeDir(label.environment),
          currentPid: process.pid,
        }),
      ],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 10_000,
        tolerateNonZeroExit: true,
      },
    );
    return parseProcessIdJson(result.stdout);
  } catch {
    return null;
  }
}

interface SlotProcessScanOptions {
  readonly hostHome: string;
  readonly currentPid: number;
}

function buildSlotProcessScanScript(options: SlotProcessScanOptions): string {
  const hostPaths = powershellStringArray(
    slotHostProcessPaths(options.hostHome),
  );
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$excluded = @(${options.currentPid}, $PID)`,
    `$hostPaths = @(${hostPaths})`,
    "$matches = Get-CimInstance Win32_Process | Where-Object {",
    "  $pidValue = [int]$_.ProcessId",
    "  if ($excluded -contains $pidValue) {",
    "    $false",
    "  } else {",
    "    $exe = ([string]$_.ExecutablePath).ToLowerInvariant().Replace('/', '\\')",
    "    $cmd = ([string]$_.CommandLine).ToLowerInvariant().Replace('/', '\\')",
    '    $text = $exe + "`n" + $cmd',
    "    $hostMatch = $false",
    "    foreach ($path in $hostPaths) {",
    "      if ($text.Contains($path)) { $hostMatch = $true; break }",
    "    }",
    "    $hostMatch",
    "  }",
    "}",
    "@($matches | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress",
  ].join("\n");
}

function slotHostProcessPaths(hostHome: string): readonly string[] {
  return [
    processPathPrefix(join(hostHome, "install")),
    processPathPrefix(join(hostHome, "install-staging")),
    processPath(join(hostHome, "install.old-")),
    processPath(join(hostHome, "host.log")),
    processPath(join(hostHome, "pid.json")),
  ];
}

function processPath(value: string): string {
  return value
    .replace(/[\\/]+$/, "")
    .toLowerCase()
    .replace(/\//g, "\\");
}

function processPathPrefix(value: string): string {
  return `${processPath(value)}\\`;
}

function powershellStringArray(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function parseProcessIdJson(stdout: string): readonly number[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isKillableProcessId);
}

function uniqueProcessIds(values: readonly number[]): readonly number[] {
  return Array.from(new Set(values.filter(isKillableProcessId)));
}

function isKillableProcessId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value !== process.pid
  );
}

interface BuildTaskXmlOptions {
  readonly label: ServiceLabel;
  readonly cli: CliInvocation;
}

interface TaskExecAction {
  readonly command: string;
  readonly argumentsLine: string;
}

// Quote a single token for a Windows command line the way CommandLineToArgvW
// parses it: a backslash is literal unless it runs up to a `"`. So we double
// only the backslashes immediately before a quote (escaping the quote with one
// extra) and those before the closing quote we append, leaving interior path
// separators like the ones in `C:\Users\foo` untouched.
function quoteWindowsArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function hiddenHostLauncherPath(label: ServiceLabel): string {
  // Install-scoped (not the shared environment home): each dev slot registers
  // its own Scheduled Task with its own CliInvocation, so the launcher must be
  // per-slot too - a shared path would let one slot's install overwrite the
  // launcher another slot's task runs.
  return join(cliInstallHomeDir(label.environment), "host-start-hidden.vbs");
}

function buildHiddenHostLauncher(cli: CliInvocation): string {
  const commandLine = [cli.command, ...cli.args, "host", "start"]
    .map(quoteWindowsArg)
    .join(" ");
  return [
    "Option Explicit",
    "Dim shell",
    "Dim exitCode",
    'Set shell = CreateObject("WScript.Shell")',
    `exitCode = shell.Run(${quoteVbsString(commandLine)}, 0, True)`,
    "WScript.Quit exitCode",
    "",
  ].join("\r\n");
}

async function writeHiddenHostLauncher(
  options: BuildTaskXmlOptions,
): Promise<void> {
  const launcherPath = hiddenHostLauncherPath(options.label);
  await mkdir(dirname(launcherPath), { recursive: true });
  const body = buildHiddenHostLauncher(options.cli);
  await writeFile(launcherPath, Buffer.from(`\uFEFF${body}`, "utf16le"));
}

function windowsSystemExecutable(filename: string): string {
  const root =
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return `${root.replace(/[\\/]+$/, "")}\\System32\\${filename}`;
}

function buildTaskAction(label: ServiceLabel): TaskExecAction {
  const argv = ["//B", "//Nologo", hiddenHostLauncherPath(label)];
  return {
    command: windowsSystemExecutable("wscript.exe"),
    argumentsLine: argv.map(quoteWindowsArg).join(" "),
  };
}

function buildTaskXml(options: BuildTaskXmlOptions): string {
  // Task Scheduler shows console-subsystem executables launched directly from
  // an interactive task. Use the GUI Windows Script Host as the root process,
  // then have the generated launcher run the CLI hidden.
  //
  // `Priority: 4` (Normal band) instead of Task Scheduler's default 7 (Below
  // Normal CPU + Low I/O priority) - the host does latency-sensitive RPC work
  // and its priority class is inherited by every child it spawns (git,
  // provider CLIs), so the throttled band starved the whole app. Windows
  // counterpart of the macOS LaunchAgent ProcessType Background->Standard fix.
  const action = buildTaskAction(options.label);
  const userId = resolveTaskUserId();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(options.label.displayName)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(action.command)}</Command>
      <Arguments>${escapeXml(action.argumentsLine)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// Resolve the Task XML `<UserId>` value. schtasks requires a fully
// qualified `<domain>\<name>` for domain-joined machines and accepts a
// bare `<name>` for local accounts. We can't easily distinguish the two
// from inside Node without Win32 API calls, so we lean on the env vars
// that the shell sets at logon:
//   - USERDOMAIN + USERNAME both set, non-empty → `<domain>\<name>`
//   - USERNAME only → bare `<name>` (local-account path)
//   - neither → fail closed; missing identity would produce a Task XML
//     that schtasks rejects with a confusing error
//
// TODO(microsoft-account-sid): For users signed in with a Microsoft
// account, Windows exposes the identity as a SID
// (`S-1-12-1-...`) reached through the LookupAccountName / NetUserGetInfo
// Win32 APIs. That requires a native helper out of scope for this fix.
// The current heuristic is correct for the local + domain-joined
// majority; MSA users will see the bare USERNAME fallback, which
// schtasks usually accepts for their local profile.
function resolveTaskUserId(): string {
  const domain = process.env.USERDOMAIN ?? "";
  const name = process.env.USERNAME ?? "";
  if (domain.length > 0 && name.length > 0) {
    return `${domain}\\${name}`;
  }
  if (name.length > 0) {
    return name;
  }
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message:
      "schtasks: cannot resolve a Task XML <UserId>; neither USERDOMAIN nor USERNAME is set in the environment. " +
      "Run `traycer host service install` from an interactive logon session.",
    details: { USERDOMAIN: domain, USERNAME: name },
    exitCode: 1,
  });
}

export {
  buildTaskXml as buildScheduledTaskXml,
  buildHiddenHostLauncher as buildWindowsHiddenHostLauncher,
  buildSlotProcessScanScript as buildWindowsSlotProcessScanScript,
  parseProcessIdJson as parseWindowsProcessIdJson,
};
