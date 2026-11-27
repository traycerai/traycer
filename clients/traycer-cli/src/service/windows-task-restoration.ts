import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";
import { reportBoundedWait } from "../runner/bounded-wait-progress";
import { windowsTaskName, type ServiceLabel } from "./label";
import { runCommand, type RunResult } from "./process-runner";
import {
  confirmStartOrRetry,
  type StartConfirmation,
} from "./start-confirmation";
import { windowsSystemPath } from "./windows-system-path";

export const WINDOWS_RESTORE_UNCONFIRMED =
  "The service start could not be confirmed. Retry with 'traycer host start'.";
export const WINDOWS_TASK_STOP_BASELINE_FILENAME = "task-stop-baseline";

const RESTORE_WINDOW_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 3_000;
const RESTORE_POLL_MS = 250;
const RETRY_DELAY_MS = 1_000;
const STOPPED_EXIT_CODE = 2;

export type WindowsTaskBaseline = readonly string[] | null;

export function encodeWindowsTaskBaseline(
  baseline: WindowsTaskBaseline,
): string {
  return baseline === null ? "unknown" : baseline.join(",") || "none";
}

export function parseWindowsTaskBaseline(value: string): WindowsTaskBaseline {
  if (value === "none") return [];
  const ids = value.split(",");
  return ids.every((id) =>
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id),
  )
    ? ids
    : null;
}

export async function captureWindowsTaskBaseline(
  label: ServiceLabel,
): Promise<WindowsTaskBaseline> {
  const result = await runWorker(
    taskWorker(windowsTaskName(label), null, 0),
    SNAPSHOT_TIMEOUT_MS,
  );
  return result?.exitCode === 0
    ? parseWindowsTaskBaseline(result.stdout.trim())
    : null;
}

/** Request the registered task using Scheduler alone. No mutation lock or adoption proof. */
export async function restoreWindowsTask(
  label: ServiceLabel,
  baseline: WindowsTaskBaseline,
): Promise<boolean> {
  reportBoundedWait("confirming the Windows service task is running");
  const deadline = performance.now() + RESTORE_WINDOW_MS;
  const run = async (phase: 1 | 2): Promise<StartConfirmation> => {
    const result = await runWorker(
      taskWorker(windowsTaskName(label), baseline, phase),
      Math.floor(deadline - performance.now()),
    );
    if (result?.exitCode === 0) return { kind: "running" };
    if (result?.exitCode === STOPPED_EXIT_CODE) return { kind: "stopped" };
    return { kind: "unknown" };
  };
  const failure = new Error(WINDOWS_RESTORE_UNCONFIRMED);
  try {
    await confirmStartOrRetry(
      await run(1),
      async () => {
        if ((await run(2)).kind !== "running") throw failure;
      },
      failure,
    );
    return true;
  } catch {
    return false;
  }
}

async function runWorker(
  script: string,
  timeoutMs: number,
): Promise<RunResult | null> {
  if (timeoutMs <= 0) return null;
  const deadline = performance.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
      runCommand(
        powershellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: undefined,
          cwd: undefined,
          timeoutMs,
          tolerateNonZeroExit: true,
        },
      ),
    ]);
    return performance.now() < deadline ? result : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function powershellPath(): string {
  return windowsSystemPath("WindowsPowerShell\\v1.0\\powershell.exe");
}

export function renderWindowsTaskRestoration(
  taskName: string,
  baseline: WindowsTaskBaseline,
): string {
  return `
$restoreBaseline = ${powershellSingleQuoted(encodeWindowsTaskBaseline(baseline))}
function Restore-RegisteredTask {
  $restoreClock = [Diagnostics.Stopwatch]::StartNew()
  foreach ($phase in @(1, 2)) {
    $worker = {
${taskWorkerBody(taskName)}
    }
    $baselineAssignment = '$baselineText = ' + "'" + $restoreBaseline + "'"
    $command = '$restorePhase = ' + $phase + [Environment]::NewLine + $baselineAssignment + [Environment]::NewLine + $worker.ToString()
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = ${powershellSingleQuoted(powershellPath())}
    $start.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encoded
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = $null
    try {
      if ($restoreClock.ElapsedMilliseconds -ge ${RESTORE_WINDOW_MS}) { break }
      $process = [Diagnostics.Process]::Start($start)
      $remaining = [Math]::Max(0, ${RESTORE_WINDOW_MS} - $restoreClock.ElapsedMilliseconds)
      if ($remaining -le 0 -or -not $process.WaitForExit([int]$remaining)) {
        try { $process.Kill() } catch {}
        break
      }
      if ($restoreClock.ElapsedMilliseconds -ge ${RESTORE_WINDOW_MS}) { break }
      if ($process.ExitCode -eq 0) { return $null }
      if ($process.ExitCode -ne ${STOPPED_EXIT_CODE}) { break }
    } catch {
      break
    } finally {
      if ($null -ne $process) { $process.Dispose() }
    }
  }
  return ${powershellSingleQuoted(WINDOWS_RESTORE_UNCONFIRMED)}
}
`;
}

function taskWorker(
  taskName: string,
  baseline: WindowsTaskBaseline,
  phase: 0 | 1 | 2,
): string {
  return `$restorePhase = ${phase}\n$baselineText = ${powershellSingleQuoted(encodeWindowsTaskBaseline(baseline))}\n${taskWorkerBody(taskName)}`;
}

function taskWorkerBody(taskName: string): string {
  return `$ErrorActionPreference = 'Stop'
function Open-RegisteredTask {
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  return $scheduler.GetFolder('\\').GetTask(${powershellSingleQuoted(taskName)})
}
function Read-Instances($task) {
  $instances = $task.GetInstances(0)
  for ($i = 1; $i -le $instances.Count; $i++) {
    $instance = $instances.Item($i)
    [pscustomobject]@{
      Id = [Guid]::Parse($instance.InstanceGuid).ToString('D')
      Running = ([int]$instance.State -eq 4)
    }
  }
}
function Request-RegisteredTask($task) {
  $null = $task.Run($null)
}
try {
  $task = Open-RegisteredTask
  $previous = @()
  $known = $true
  if ($restorePhase -eq 0 -or ($restorePhase -eq 1 -and $baselineText -eq 'unknown')) {
    try {
      $previous = @(Read-Instances $task)
      # An unelevated caller can get an empty collection for a running
      # elevated task. Empty is affirmative only with TASK_STATE_READY.
      $known = $previous.Count -gt 0 -or [int]$task.State -eq 3
    } catch {
      $known = $false
    }
    if ($restorePhase -eq 0) {
      if (-not $known) { exit 1 }
      if ($previous.Count -eq 0) { [Console]::Write('none') }
      else { [Console]::Write(($previous.Id -join ',')) }
      exit 0
    }
    $previous = @($previous.Id | Where-Object { $_ })
  } elseif ($restorePhase -eq 1 -and $baselineText -ne 'none') {
    $previous = @($baselineText.Split(','))
  }
  # Phase 2 is admitted only after phase 1 saw an empty, ready task.
  try { Request-RegisteredTask $task } catch {}
  $observeClock = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      $current = @(Read-Instances $task)
      $draining = @($current | Where-Object { $previous -contains $_.Id })
      $running = @($current | Where-Object { $_.Running })
      if ($known -and $draining.Count -eq 0 -and $running.Count -gt 0) { exit 0 }
      if ($restorePhase -eq 1 -and $observeClock.ElapsedMilliseconds -ge ${RETRY_DELAY_MS} -and
          $current.Count -eq 0 -and [int]$task.State -eq 3) { exit ${STOPPED_EXIT_CODE} }
    } catch {
      # An unavailable Scheduler read is neither confirmation nor permission to retry.
    }
    Start-Sleep -Milliseconds ${RESTORE_POLL_MS}
  }
} catch {
  exit 1
}
`;
}
