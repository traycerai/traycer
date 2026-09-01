import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  isServiceMutationAuthorityError,
  verifyServiceMutationAuthority,
} from "../mutation-authority";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HOST_CAPABILITY_HOST_START_ADOPTION_V2,
  HOST_CAPABILITY_SERVICE_LABEL,
} from "../../host/capabilities";
import {
  readHostPidMetadata,
  removeHostPidMetadata,
} from "../../host/pid-metadata";
import {
  captureSpawnEvidenceBaseline,
  createSpawnEvidenceReader,
  sleep,
  type SpawnEvidenceBaseline,
  type SpawnEvidenceReader,
} from "../../host/spawn-evidence";
import {
  WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
  WINDOWS_SCHTASKS_END_TIMEOUT_MS,
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS,
  WINDOWS_START_SPAWN_POLL_MS,
  WINDOWS_START_SPAWN_VERIFY_MS,
  WINDOWS_TASKKILL_TIMEOUT_MS,
} from "@traycer/protocol/host/lifecycle-constants";
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
  const unverifiedRun: ProcessRunner = runner ?? runCommand;
  const run: ProcessRunner = async (command, args, options) => {
    await verifyServiceMutationAuthority();
    return unverifiedRun(command, args, options);
  };
  return {
    install: (options) => installService(options, run),
    uninstall: (options) => uninstallService(options, run),
    status: (label) => statusService(label),
    stop: (label) => stopService(label, run),
    start: (label) => startService(label, run),
    restart: (label) => restartService(label, run),
    hostStartAdoptionLabel: (label) => Promise.resolve(label.id),
    // No Desktop/SMAppService split on Windows, so the restart halves are the
    // stop and start `host restart` already performed - the named seam exists
    // so the command has one shape on every platform. `forcedRecycle` is
    // never set: `stopService` taskkills and waits, so nothing survives to
    // need a recycle.
    stopForRestart: async (label) => {
      await stopService(label, run);
      return { forcedRecycle: false };
    },
    relaunchAfterRestart: (label) => startService(label, run),
    // SMAppService is macOS-only, so there is no second registration path
    // that could compete with the Scheduled Task here.
    retireCompetingRegistration: () =>
      Promise.resolve({ kind: "not-applicable" }),
    takeoverDesktopRegistration: () =>
      Promise.resolve({ kind: "not-applicable" }),
  };
}

// Injectable evidence seams so unit tests can drive the post-`/Run`
// verification ladder without a real filesystem or host process.
export interface WindowsStartEvidenceDeps {
  readonly captureBaseline: (
    environment: ServiceLabel["environment"],
  ) => Promise<SpawnEvidenceBaseline>;
  readonly createEvidenceReader: (
    baseline: SpawnEvidenceBaseline,
  ) => SpawnEvidenceReader;
  readonly sleep: (ms: number) => Promise<void>;
  readonly verifyTimeoutMs: number;
  readonly verifyPollMs: number;
}

const defaultStartEvidenceDeps: WindowsStartEvidenceDeps = {
  captureBaseline: (environment) => captureSpawnEvidenceBaseline(environment),
  createEvidenceReader: (baseline) => createSpawnEvidenceReader(baseline),
  sleep,
  verifyTimeoutMs: WINDOWS_START_SPAWN_VERIFY_MS,
  verifyPollMs: WINDOWS_START_SPAWN_POLL_MS,
};

let startEvidenceDeps: WindowsStartEvidenceDeps = defaultStartEvidenceDeps;

/** Test-only override for the start-verification evidence seams. */
export function setWindowsStartEvidenceDepsForTests(
  deps: WindowsStartEvidenceDeps | null,
): void {
  startEvidenceDeps = deps ?? defaultStartEvidenceDeps;
}

interface StagedWindowsTaskDefinition {
  readonly tmpDir: string;
  readonly xmlPath: string;
}

export interface WindowsTaskInstallDeps {
  stageTaskDefinition(
    options: InstallServiceOptions,
  ): Promise<StagedWindowsTaskDefinition>;
  removeStagedTaskDefinition(tmpDir: string): Promise<void>;
}

const defaultTaskInstallDeps: WindowsTaskInstallDeps = {
  stageTaskDefinition: async (options) => {
    await verifyServiceMutationAuthority();
    const tmpDir = await mkdtemp(join(tmpdir(), "traycer-task-"));
    const xmlPath = join(tmpDir, "task.xml");
    await writeHiddenHostLauncher(options);
    const xmlBody = buildTaskXml({ label: options.label, cli: options.cli });
    await verifyServiceMutationAuthority();
    await writeFile(xmlPath, Buffer.from(`﻿${xmlBody}`, "utf16le"));
    return { tmpDir, xmlPath };
  },
  removeStagedTaskDefinition: async (tmpDir) => {
    await verifyServiceMutationAuthority();
    await rm(tmpDir, { recursive: true, force: true });
  },
};

let taskInstallDeps: WindowsTaskInstallDeps = defaultTaskInstallDeps;

/** Test-only replacement for task-definition filesystem staging. */
export function setWindowsTaskInstallDepsForTests(
  deps: WindowsTaskInstallDeps | null,
): void {
  taskInstallDeps = deps ?? defaultTaskInstallDeps;
}

async function installService(
  options: InstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  const taskName = windowsTaskName(options.label);
  // schtasks /Create /XML reads a UTF-16LE task definition from a private,
  // per-invocation staging directory. Keep staging separate from the runner so
  // the controller's install → verified `/Run` composition can be unit-tested
  // without touching a real user service surface.
  const staged = await taskInstallDeps.stageTaskDefinition(options);
  try {
    await run(
      "schtasks",
      ["/Create", "/TN", taskName, "/XML", staged.xmlPath, "/F"],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 30_000,
        tolerateNonZeroExit: false,
      },
    );
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    // Roll the launcher back: `stageTaskDefinition` wrote the persistent
    // VBS before /Create ran, and a launcher without a task is an orphan
    // that outlives the failed install (only a later uninstall would
    // collect it). Best-effort - the error the operator sees is the
    // install failure, not the rollback's.
    await verifyServiceMutationAuthority();
    await rm(hiddenHostLauncherPath(options.label), { force: true }).catch(
      () => undefined,
    );
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `schtasks /Create failed for ${taskName}: ${describeCause(cause)}`,
      details: { task: taskName, cause: describeCause(cause) },
      exitCode: 1,
    });
  } finally {
    await taskInstallDeps.removeStagedTaskDefinition(staged.tmpDir);
  }
  // Registration is also the recovery launch. Verify this exact `/Run` so
  // callers never baseline after it and mistake IgnoreNew's suppressed second
  // run for a failed repair.
  await runTaskAndVerifyStart(options.label, run);
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
  await verifyServiceMutationAuthority();
  await rm(hiddenHostLauncherPath(options.label), { force: true });
  // `schtasks /Delete` removes only the task; the `\Traycer` FOLDER it was
  // auto-created in stays behind forever (probed live on Windows 11: the
  // empty folder remains visible in Task Scheduler Library - and folders
  // show even though the task itself was hidden). schtasks has no verb for
  // folders, so ask the Schedule.Service COM API - and ONLY when the
  // folder is genuinely empty: other environments' tasks (`Host-Dev`,
  // `Host-Staging`) live in the same folder and must survive this
  // uninstall. Best-effort: a missing folder or denied delete changes
  // nothing about the uninstall's outcome.
  await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\Traycer');if((@($f.GetTasks(1)).Count -eq 0) -and (@($f.GetFolders(0)).Count -eq 0)){$s.GetFolder('\\').DeleteFolder('Traycer',0)}",
    ],
    {
      env: undefined,
      cwd: undefined,
      timeoutMs: 30_000,
      tolerateNonZeroExit: true,
    },
  ).catch((cause) => {
    if (isServiceMutationAuthorityError(cause)) throw cause;
  });
  // Same rationale as stopService: the force-kill above skips the host's
  // graceful pid.json cleanup, and metadata surviving an uninstall reads as
  // a crashed (rather than removed) host to anything that finds it later.
  await verifyServiceMutationAuthority();
  await removeHostPidMetadata(options.label.environment);
}

async function statusService(label: ServiceLabel): Promise<ServiceStatus> {
  const taskName = windowsTaskName(label);
  let registered: boolean;
  try {
    await runCommand("schtasks", ["/Query", "/TN", taskName], {
      env: undefined,
      cwd: undefined,
      timeoutMs: WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
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
    timeoutMs: WINDOWS_SCHTASKS_END_TIMEOUT_MS,
    tolerateNonZeroExit: true,
  });
  await killHostProcessTree(label, run);
  // The force-kill above never lets the host honor its "remove pid.json on
  // graceful shutdown" contract, and metadata left behind makes this
  // deliberate stop indistinguishable from a crash - the desktop's health
  // watchdog would resurrect the host the user just stopped.
  await verifyServiceMutationAuthority();
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
        timeoutMs: WINDOWS_TASKKILL_TIMEOUT_MS,
        tolerateNonZeroExit: true,
      }).catch((cause) => {
        if (isServiceMutationAuthorityError(cause)) throw cause;
      }),
    ),
  );
}

async function startService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  await runTaskAndVerifyStart(label, run);
}

async function runTaskAndVerifyStart(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  const taskName = windowsTaskName(label);
  // Capture evidence baseline BEFORE /Run so a pre-existing pid.json or
  // stale host.log residue cannot count as "spawned this attempt".
  const baseline = await startEvidenceDeps.captureBaseline(label.environment);
  const evidenceReader = startEvidenceDeps.createEvidenceReader(baseline);
  try {
    await run("schtasks", ["/Run", "/TN", taskName], {
      env: undefined,
      cwd: undefined,
      timeoutMs: WINDOWS_SCHTASKS_RUN_TIMEOUT_MS,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `schtasks /Run failed for ${taskName}: ${describeCause(cause)}`,
      details: { task: taskName, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
  // Exit 0 from /Run only means the scheduler accepted the request. Poll
  // for post-baseline spawn evidence (pid metadata written after the run
  // baseline, or a post-baseline bootstrap marker). On none, surface the
  // task's Last Run Result so Retry can escalate to a task rewrite.
  const deadline = Date.now() + startEvidenceDeps.verifyTimeoutMs;
  while (Date.now() < deadline) {
    const evidence = await evidenceReader.collect(label.environment);
    if (evidence !== null) {
      return;
    }
    await startEvidenceDeps.sleep(startEvidenceDeps.verifyPollMs);
  }
  const lastRunResult = await readTaskLastRunResult(taskName, run);
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message:
      lastRunResult === null
        ? `schtasks /Run for ${taskName} accepted the request but no host spawn evidence appeared within ${startEvidenceDeps.verifyTimeoutMs}ms`
        : `schtasks /Run for ${taskName} accepted the request but no host spawn evidence appeared within ${startEvidenceDeps.verifyTimeoutMs}ms (Last Run Result: ${lastRunResult})`,
    details: {
      task: taskName,
      lastRunResult,
      verifyTimeoutMs: startEvidenceDeps.verifyTimeoutMs,
    },
    exitCode: 1,
  });
}

/**
 * Parse `Last Run Result` from a headerless `schtasks /Query /V /FO CSV`
 * response. CSV's fixed output column is locale-independent, unlike the
 * translated `Last Run Result` label from `/FO LIST`.
 */
async function readTaskLastRunResult(
  taskName: string,
  run: ProcessRunner,
): Promise<string | null> {
  try {
    const result = await run(
      "schtasks",
      ["/Query", "/TN", taskName, "/V", "/FO", "CSV", "/NH"],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
        tolerateNonZeroExit: true,
      },
    );
    return parseSchtasksLastRunResult(result.stdout);
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return null;
  }
}

export function parseSchtasksLastRunResult(stdout: string): string | null {
  const csv = parseSchtasksCsvRow(stdout);
  // `schtasks /FO CSV` uses column six (zero-based) for Last Run Result.
  // The positions remain stable while their rendered headers are localized.
  if (csv !== null && csv.length > 6) {
    const value = (csv[6] ?? "").trim();
    return value.length === 0 ? null : value;
  }
  // Compatibility for existing callers/tests that still hand us `/FO LIST`
  // output. Production uses the CSV path above.
  const match = /Last\s+Run\s+Result\s*:\s*(.+)\s*$/im.exec(stdout);
  if (match === null) return null;
  const value = (match[1] ?? "").trim();
  return value.length === 0 ? null : value;
}

function parseSchtasksCsvRow(stdout: string): readonly string[] | null {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined || !line.includes(",")) return null;
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      values.push(value);
      value = "";
      continue;
    }
    value += character;
  }
  values.push(value);
  return values;
}

async function restartService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  const taskName = windowsTaskName(label);
  await run("schtasks", ["/End", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: WINDOWS_SCHTASKS_END_TIMEOUT_MS,
    tolerateNonZeroExit: true,
  });
  // Reap the orphaned host tree before re-running, otherwise the old node keeps
  // its port + install dir and the fresh task races a stale host.
  await killHostProcessTree(label, run);
  // Restart reuses the verified start path (baseline + post-/Run evidence)
  // so a stop-then-start that the scheduler accepts but never spawns fails
  // with Last Run Result instead of a silent no-op.
  await startService(label, run);
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
        timeoutMs: WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
        tolerateNonZeroExit: true,
      },
    );
    return parseProcessIdJson(result.stdout);
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return null;
  }
}

interface SlotProcessScanOptions {
  readonly hostHome: string;
  readonly currentPid: number;
}

function buildSlotProcessScanScript(options: SlotProcessScanOptions): string {
  return buildSlotProcessScanScriptWithProjection(
    options,
    "@($matches | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress",
  );
}

// Same filter as the pid scan, projecting name + executable path as well so
// the install swap's EBUSY error can NAME the processes still matching the
// slot instead of surfacing a bare errno.
function buildSlotProcessDetailScanScript(
  options: SlotProcessScanOptions,
): string {
  return buildSlotProcessScanScriptWithProjection(
    options,
    "@($matches | Select-Object ProcessId, Name, ExecutablePath) | ConvertTo-Json -Compress",
  );
}

function buildSlotProcessScanScriptWithProjection(
  options: SlotProcessScanOptions,
  projection: string,
): string {
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
    projection,
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
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isKillableProcessId);
}

function uniqueProcessIds(values: readonly number[]): readonly number[] {
  return Array.from(new Set(values.filter(isKillableProcessId)));
}

// A slot-matching process reported by the detail scan. Field names mirror
// the installer's `SwapLockHolderProcess` so `install-lifecycle.ts` can
// hand these through without an adapter layer.
export interface WindowsSlotLockHolder {
  readonly pid: number;
  readonly name: string | null;
  readonly executablePath: string | null;
}

function parseProcessDetailJson(
  stdout: string,
): readonly WindowsSlotLockHolder[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  // `ConvertTo-Json` on `@(...)` still emits a bare object for a single
  // match on Windows PowerShell 5.1 - accept both shapes, like
  // `parseProcessIdJson` above.
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const holders: WindowsSlotLockHolder[] = [];
  for (const value of values) {
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const pid = record.ProcessId;
    if (!isKillableProcessId(pid)) continue;
    holders.push({
      pid,
      name: readNonEmptyString(record.Name),
      executablePath: readNonEmptyString(record.ExecutablePath),
    });
  }
  return holders;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The install swap's between-retry escalation (installer
// `SwapLockRecovery.killLingeringProcesses`): re-run the same verified
// kill `stopService` already performed. The first kill ran before the
// swap; anything the rename now trips over either outlived it (an orphan
// re-matching the scan) or spawned since, and both answer to another pass.
// Pass `null` to use the real process runner.
export async function killLingeringSlotProcesses(
  label: ServiceLabel,
  runner: ProcessRunner | null,
): Promise<void> {
  await killHostProcessTree(label, runner ?? runCommand);
}

// The install swap's post-mortem (`SwapLockRecovery.describeLockHolders`):
// name the processes the slot scan still matches after the rename retries
// exhausted. Best-effort - a scan that cannot run reports no holders
// rather than failing the caller, which is already surfacing an error.
export async function describeSlotLockHolders(
  label: ServiceLabel,
  runner: ProcessRunner | null,
): Promise<readonly WindowsSlotLockHolder[]> {
  const run = runner ?? runCommand;
  try {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        buildSlotProcessDetailScanScript({
          hostHome: hostHomeDir(label.environment),
          currentPid: process.pid,
        }),
      ],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
        tolerateNonZeroExit: true,
      },
    );
    return parseProcessDetailJson(result.stdout);
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return [];
  }
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
//
// SCOPE - two different quoting dialects live on Windows and they are NOT
// interchangeable:
//
//   * THIS one (MSVCRT / CommandLineToArgvW argv rules, `"` -> `\"`) is for a
//     command line a process receives directly: `WScript.Shell.Run`, the
//     Scheduled Task `<Arguments>` line, `CreateProcess`.
//   * A string handed to `cmd.exe /d /s /c` needs PLAIN `"` quoting instead -
//     cmd.exe has never understood `\"` and treats the backslash as literal,
//     mangling the command token. See `resolveSpawnInvocation` in
//     commands/host-start.ts for that form.
//
// Passing a cmd.exe line through this function produces a line cmd cannot
// resolve, which fails silently as a non-zero exit. Nothing in this file
// shells through cmd.exe any more - the capability probe below runs the CLI
// directly, precisely so there is only one dialect in play here.
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

/**
 * The Scheduled Task's hidden launcher.
 *
 * The Task definition outlives the CLI binary it points at, so the launcher
 * asks that binary whether it understands the identity flag before passing
 * it. The probe is `host capabilities --has service-label` run DIRECTLY via
 * `shell.Run` - same argv quoting as the line right beside it, no `cmd.exe`
 * hop and no `findstr` pipe:
 *
 *   * the previous form wrapped a cmd.exe line with `quoteWindowsArg`, whose
 *     `\"` escaping cmd.exe does not honour - cmd could never resolve the
 *     command token, the probe always returned non-zero, and the task started
 *     the host UNLABELLED on every login, permanently and silently;
 *   * an exit code needs no output parsing, so there is no help-text layout
 *     and no `findstr` availability to depend on.
 *
 * `shell.Run` raises a VBScript runtime error (rather than returning a code)
 * when the image cannot be launched at all, so the probe is wrapped in
 * `On Error Resume Next`: any failure to even ask degrades to the unlabelled
 * start, never to an aborted script that leaves the machine hostless.
 */
function buildHiddenHostLauncher(
  cli: CliInvocation,
  label: ServiceLabel,
): string {
  const invocation = [cli.command, ...cli.args];
  const commandLine = [...invocation, "host", "start"]
    .map(quoteWindowsArg)
    .join(" ");
  const labelledCommandLine = [
    commandLine,
    quoteWindowsArg("--service-label"),
    quoteWindowsArg(label.id),
  ].join(" ");
  const capabilityProbe = [
    ...invocation,
    "host",
    "capabilities",
    "--has",
    HOST_CAPABILITY_SERVICE_LABEL,
  ]
    .map(quoteWindowsArg)
    .join(" ");
  const adoptionNonceProbe = [
    ...invocation,
    "host",
    "adoption-nonce",
    "--service-label",
    label.id,
  ]
    .map(quoteWindowsArg)
    .join(" ");
  const adoptionCapabilityProbe = [
    ...invocation,
    "host",
    "capabilities",
    "--has",
    HOST_CAPABILITY_HOST_START_ADOPTION_V2,
  ]
    .map(quoteWindowsArg)
    .join(" ");
  return [
    "Option Explicit",
    "Dim shell",
    "Dim exitCode",
    "Dim commandLine",
    "Dim probeStatus",
    "Dim adoptionCapabilityStatus",
    "Dim nonceProbe",
    "Dim adoptionNonce",
    "Dim noncePattern",
    'Set shell = CreateObject("WScript.Shell")',
    `commandLine = ${quoteVbsString(commandLine)}`,
    "On Error Resume Next",
    `probeStatus = shell.Run(${quoteVbsString(capabilityProbe)}, 0, True)`,
    "If Err.Number <> 0 Then probeStatus = 1",
    "Err.Clear",
    "On Error Goto 0",
    "If probeStatus = 0 Then",
    '  adoptionNonce = ""',
    "  On Error Resume Next",
    `  adoptionCapabilityStatus = shell.Run(${quoteVbsString(adoptionCapabilityProbe)}, 0, True)`,
    "  If Err.Number <> 0 Then adoptionCapabilityStatus = 1",
    "  Err.Clear",
    "  If adoptionCapabilityStatus = 0 Then",
    `    Set nonceProbe = shell.Exec(${quoteVbsString(adoptionNonceProbe)})`,
    "    If Err.Number = 0 Then",
    "      Do While nonceProbe.Status = 0",
    "        WScript.Sleep 10",
    "      Loop",
    "      If nonceProbe.ExitCode = 0 Then adoptionNonce = Trim(nonceProbe.StdOut.ReadAll)",
    "    End If",
    "  End If",
    "  Err.Clear",
    "  On Error Goto 0",
    "  Set noncePattern = New RegExp",
    '  noncePattern.Pattern = "^[0-9A-Fa-f-]{36}$"',
    "  If noncePattern.Test(adoptionNonce) Then",
    `    commandLine = ${quoteVbsString(labelledCommandLine)} & " --adoption-nonce " & Chr(34) & adoptionNonce & Chr(34)`,
    "  Else",
    `    commandLine = ${quoteVbsString(labelledCommandLine)}`,
    "  End If",
    "End If",
    // Exit 75 is the CLI's restart-into-refreshed-slot signal (see
    // EXIT_RESTART_INTO_REFRESHED_SLOT in index.ts): the supervised entry
    // just replaced the slot binary and wants to be relaunched from it. On
    // systemd and launchd the service manager does that relaunch; Task
    // Scheduler's only knob is RestartOnFailure - minute-granularity, three
    // attempts, and whether a nonzero action exit even counts as a
    // "failure" is an OS semantic nothing here can pin down. So the
    // launcher handles its own restart: bounded, because the refreshed slot
    // reports itself current on the very next run, so a second 75 in a row
    // means the refresh is NOT converging and looping on it would burn a
    // ~100 MB copy per lap with the host never up.
    "Dim attempts",
    "attempts = 0",
    "Do",
    "  exitCode = shell.Run(commandLine, 0, True)",
    "  attempts = attempts + 1",
    "Loop While exitCode = 75 And attempts < 3",
    "WScript.Quit exitCode",
    "",
  ].join("\r\n");
}

async function writeHiddenHostLauncher(
  options: BuildTaskXmlOptions,
): Promise<void> {
  const launcherPath = hiddenHostLauncherPath(options.label);
  await verifyServiceMutationAuthority();
  await mkdir(dirname(launcherPath), { recursive: true });
  const body = buildHiddenHostLauncher(options.cli, options.label);
  await verifyServiceMutationAuthority();
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
  // counterpart of the macOS LaunchAgent `ProcessType: Interactive` fix in
  // platforms/macos.ts (that one landed in two steps - Background->Standard,
  // then Standard->Interactive once `Standard` turned out to be launchd's
  // throttled default rather than an unthrottled middle band).
  const action = buildTaskAction(options.label);
  const userId = resolveTaskUserId();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Traycer</Author>
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
  buildSlotProcessDetailScanScript as buildWindowsSlotProcessDetailScanScript,
  parseProcessIdJson as parseWindowsProcessIdJson,
  parseProcessDetailJson as parseWindowsProcessDetailJson,
};
