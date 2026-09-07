import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  isServiceMutationAuthorityError,
  verifyServiceMutationAuthority,
} from "../mutation-authority";
import { markRegistrationCommitted } from "../cli-invocation-record";
import { createCliLogger } from "../../logger";
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
  WINDOWS_KILL_CONVERGENCE_ROUNDS,
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

// Windows service controller - per-user Scheduled Task.
// Per the Tech Plan we never elevate; if a future change ever needed admin we'd fall back to user-only and surface a doctor message rather than prompting for UAC.

// Pluggable runner shape kept consistent with macOS so tests can exercise the
// controller without touching schtasks/taskkill.
export type ProcessRunner = typeof runCommand;

/** The clock the kill loop bounds its carry-over with, in epoch MICROSECONDS - the same unit and epoch the scan projects `CreationDate` into, which is the only reason the two can be compared at all. `Date.now()` is milliseconds, so this is coarser than its unit suggests: it names an instant up to 999us EARLIER than the true one. */
export function epochMicrosNow(): number {
  return Date.now() * 1000;
}

/** Seams the kill loop needs from the outside world. */
export interface WindowsControllerDeps {
  /** The current time in MICROSECONDS since the Unix epoch - the unit `WindowsProcessTableRow.created` is projected in, because the kill loop compares the two directly to bound each victim's lifetime. Production passes `epochMicrosNow`. */
  readonly now: () => number;
}

export function createWindowsController(
  runner: ProcessRunner | null,
  deps: WindowsControllerDeps,
): ServiceController {
  const unverifiedRun: ProcessRunner = runner ?? runCommand;
  const run: ProcessRunner = async (command, args, options) => {
    await verifyServiceMutationAuthority();
    return unverifiedRun(command, args, options);
  };
  return {
    install: (options) => installService(options, run),
    uninstall: (options) => uninstallService(options, run, deps),
    status: (label) => statusService(label),
    stop: (label) => stopService(label, run, deps),
    start: (label) => startService(label, run),
    restart: (label) => restartService(label, run, deps),
    hostStartAdoptionLabel: (label) => Promise.resolve(label.id),
    // No Desktop/SMAppService split on Windows, so the restart halves are the stop and start `host restart` already performed - the named seam exists so the command has one shape on every platform.
    // `forcedRecycle` is never set: `stopService` taskkills and waits, so nothing survives to need a recycle.
    stopForRestart: async (label) => {
      await stopService(label, run, deps);
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
  // schtasks /Create /XML reads a UTF-16LE task definition from a private, per-invocation staging directory.
  // Keep staging separate from the runner so the controller's install → verified `/Run` composition can be unit-tested without touching a real user service surface.
  const staged = await taskInstallDeps.stageTaskDefinition(options);
  // Set the moment `/Create` returns: from here the task exists with its logon trigger, and any throw - the staging cleanup below included, whose default verifies mutation authority first - is post-registration and must reach a lease-holding caller as such (`didServiceRegistrationCommit`).
  let created = false;
  let createFailure: unknown = null;
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
    created = true;
  } catch (cause) {
    createFailure = cause;
  }
  // Staging cleanup runs before `/Create` failure is classified: an authority loss here outranks a `/Create` failure.
  const cleanupAuthorityLoss = await removeStagedTaskDefinition(
    staged.tmpDir,
    taskName,
    options.label.environment,
  );
  if (cleanupAuthorityLoss !== null) {
    throw created
      ? markRegistrationCommitted(cleanupAuthorityLoss)
      : cleanupAuthorityLoss;
  }
  if (createFailure !== null) {
    if (isServiceMutationAuthorityError(createFailure)) throw createFailure;
    // Roll the launcher back: `stageTaskDefinition` wrote the persistent VBS before /Create ran, and a launcher without a task is an orphan that outlives the failed install (only a later uninstall would collect it).
    // Best-effort - the error the operator sees is the install failure, not the rollback's.
    await verifyServiceMutationAuthority();
    await rm(hiddenHostLauncherPath(options.label), { force: true }).catch(
      () => undefined,
    );
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `schtasks /Create failed for ${taskName}: ${describeCause(createFailure)}`,
      details: { task: taskName, cause: describeCause(createFailure) },
      exitCode: 1,
    });
  }
  // Registration is also the recovery launch.
  // Verify this exact `/Run` so callers never baseline after it and mistake IgnoreNew's suppressed second run for a failed repair.
  await runTaskAndVerifyStart(options.label, run);
}

/** Remove the staging directory, returning the ONE failure that outranks whatever the caller is in the middle of: a mutation-authority loss. Every other failure is best effort and swallowed here - see the caller. */
async function removeStagedTaskDefinition(
  tmpDir: string,
  taskName: string,
  environment: ServiceLabel["environment"],
): Promise<unknown | null> {
  try {
    await taskInstallDeps.removeStagedTaskDefinition(tmpDir);
    return null;
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) return cause;
    createCliLogger(environment).debug(
      "Failed to remove the staged task definition; leaving it behind",
      { task: taskName, cause: describeCause(cause) },
    );
    return null;
  }
}

async function uninstallService(
  options: UninstallServiceOptions,
  run: ProcessRunner,
  deps: WindowsControllerDeps,
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
  await killHostProcessTree(options.label, run, deps);
  await run("schtasks", ["/Delete", "/TN", taskName, "/F"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  await verifyServiceMutationAuthority();
  await rm(hiddenHostLauncherPath(options.label), { force: true });
  // `schtasks /Delete` removes only the task; the `\Traycer` FOLDER it was auto-created in stays behind forever (probed live on Windows 11: the empty folder remains visible in Task Scheduler Library - and folders show even though the task itself was hidden). schtasks has no verb for folders, so ask the Schedule.Service COM API - and ONLY when the folder is genuinely empty: other environments' tasks (`Host-Dev`, `Host-Staging`) live in the same folder and must survive this uninstall.
  // Best-effort: a missing folder or denied delete changes nothing about the uninstall's outcome.
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
  // Same rationale as stopService: the force-kill above skips the host's graceful pid.json cleanup, and metadata surviving an uninstall reads as a crashed (rather than removed) host to anything that finds it later.
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
  deps: WindowsControllerDeps,
): Promise<void> {
  await run("schtasks", ["/End", "/TN", windowsTaskName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: WINDOWS_SCHTASKS_END_TIMEOUT_MS,
    tolerateNonZeroExit: true,
  });
  await killHostProcessTree(label, run, deps);
  // The force-kill above never lets the host honor its "remove pid.json on graceful shutdown" contract, and metadata left behind makes this deliberate stop indistinguishable from a crash - the desktop's health watchdog would resurrect the host the user just stopped.
  await verifyServiceMutationAuthority();
  await removeHostPidMetadata(label.environment);
}

// `schtasks /End` kills the task root (wscript) but can leave the host's supervisor orphaned; follow with the child-kill engine.
async function killHostProcessTree(
  label: ServiceLabel,
  run: ProcessRunner,
  deps: WindowsControllerDeps,
): Promise<void> {
  // What earlier rounds placed in the host's tree - killed, or spared as one of this CLI's own ancestors - with the age each had when it was seen.
  // The loop's memory: once a parent is dead the table can no longer prove its children belong to the slot, and this is the only thing that still can.
  const priorVictims = new Map<number, WindowsKillVictim[]>();
  // The other half of that memory: pids an earlier round could place neither in the slot nor out of it, against the age the row wearing each one had then.
  // Uncertainty has to cross a round boundary for the same reason a kill does.
  const priorSuspects = new Map<number, number[]>();
  // The third: this CLI's own ancestors, by IDENTITY (pid and creation time), for every incarnation a round saw them as ancestors.
  // Their windows go into `priorVictims` like a kill's, which is what places their other children; this is what keeps THEM protected.
  const priorProtected = new Map<number, number[]>();
  // The triple, by reference: the maps below are mutated in place at the end
  // of every round, so this is built once and always reflects the latest round.
  const memory: WindowsKillMemory = {
    victims: priorVictims,
    suspects: priorSuspects,
    protectedAncestors: priorProtected,
  };
  for (let round = 0; round <= WINDOWS_KILL_CONVERGENCE_ROUNDS; round += 1) {
    // BEFORE the scan, and that ordering is the soundness argument for the whole carry-over: every victim this round selects is one the scan below observed alive, so each was still holding its pid at this instant.
    // Read after the scan - or worse, just before the kills - the bound would cover time in which the victim may already have exited and its pid been reused.
    const seenAliveAt = deps.now();
    const table = await scanSlotProcessTable(label, run);
    if (table === null) {
      // Before the first kill this refuses to start; after one it refuses to claim the tree came down.
      // Both are the same statement - we cannot see the slot, so we cannot say what is in it - and neither may be softened into a success the caller would act on by purging pid.json.
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message:
          `could not enumerate the ${label.id} host process tree: the PowerShell process scan failed or timed out. ` +
          "Refusing to report the host stopped. Retry, or end the Traycer host processes from Task Manager.",
        details: { label: label.id, killRoundsCompleted: round },
        exitCode: 1,
      });
    }
    // The kill boundary, and the only place a pid has to be POSITIVE: the scan and its algebra work over an unfiltered table that includes pid 0, and `isKillableProcessId` is what keeps 0 - and our own pid - out of an argv.
    const killSet = computeWindowsHostKillSet(table, process.pid, memory);
    const pids = uniqueProcessIds(killSet.kill);
    const unattributed = uniqueProcessIds(killSet.unattributed);
    const undecided = uniqueProcessIds(killSet.undecided);
    const protectedAncestors = uniqueProcessIds(killSet.protectedAncestors);
    if (pids.length === 0) {
      // Nothing left to kill - but that is only convergence if nothing is UNDECIDED.
      // A row claiming a killed host process as its parent, born after that parent was last seen alive, may be a stranger wearing a recycled pid or may be a host child spawned in its parent's last moments.
      if (unattributed.length > 0) {
        // "Run the command again" was the wrong advice and is deliberately gone, for the opposite of the obvious reason: a rerun would very likely SUCCEED, and that success would prove nothing.
        // This memory is invocation-local; a fresh stop starts with no victims and no suspects, so the same orphan arrives as an ordinary process with a parent nobody remembers, and with no slot match left the loop converges around it.
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message:
            `refusing to report the ${label.id} host stopped: ${unattributed.length} process(es) could be neither tied to this slot nor ruled out of it ` +
            "(each claims a process this stop killed, spared as its own ancestor, or could not place, as its parent, or descends from one, " +
            "and was created after that parent was last seen alive or carries an unreadable creation time): " +
            `pids ${unattributed.join(", ")}. End them from Task Manager, then retry.`,
          details: { label: label.id, unattributedPids: unattributed },
          exitCode: 1,
        });
      }
      // Converged, and the only success: a scan taken AFTER the previous round's kills found nothing left in this slot and nothing undecided.
      // Round 0 reaches here whenever there was never anything to kill, which is the ordinary stop of a host that already exited - one scan, no kills.
      return;
    }
    // Out of kill passes with the slot still occupied.
    // Falling through here would report exactly what a converged scan reports, which is the one thing this function must never do: name the survivors instead, so the caller's error says which processes to deal with.
    if (round === WINDOWS_KILL_CONVERGENCE_ROUNDS) {
      // The undecided rows travel with the survivors.
      // This exit is the one the user acts on, and a list that names only what we could prove sends them to Task Manager with half the slot: the pids we could not place are as likely to be what is holding the install dir open, and they are the ones nobody else is going to point at.
      const undecided =
        unattributed.length > 0
          ? ` ${unattributed.length} further process(es) could not be placed either way: pids ${unattributed.join(", ")}.`
          : "";
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message:
          `${label.id} host processes are still running after ${WINDOWS_KILL_CONVERGENCE_ROUNDS} kill rounds (pids ${pids.join(", ")}).${undecided} ` +
          "End them from Task Manager, then retry.",
        details: {
          label: label.id,
          survivingPids: pids,
          unattributedPids: unattributed,
          killRounds: WINDOWS_KILL_CONVERGENCE_ROUNDS,
        },
        exitCode: 1,
      });
    }
    await killProcessIds(orderWindowsKillsDescendantsFirst(pids, table), run);
    // Remembered AFTER the kill, from the snapshot the kill was computed from, so each victim's age is the one it had while it was alive.
    // A row is always in the table it was selected from, so the fallback age is unreachable; 0 is the value the next round refuses to link anything to, which is the right way for it to be wrong.
    const created = new Map(table.map((row) => [row.processId, row.created]));
    for (const pid of pids) {
      rememberIncarnation(priorVictims, pid, {
        created: created.get(pid) ?? 0,
        seenAliveAt,
      });
    }
    // The CLI's own placed ancestors go into the same map, with the same window, though nothing was done to them: the shell the host spawned to run this CLI is a host descendant, its other children are the host's, and it can exit between rounds like anything else.
    // A child it spawns after this scan then claims its pid as an orphan, and the window is what says whether that child was born while the shell was demonstrably the host's (seed) or after the last time this loop saw it (undecided).
    for (const pid of protectedAncestors) {
      rememberIncarnation(priorVictims, pid, {
        created: created.get(pid) ?? 0,
        seenAliveAt,
      });
      // And by identity, so the next round still spares it when the edges that proved its ancestry are gone.
      // An unreadable age is no identity: nothing can match it, so nothing is recorded.
      const age = created.get(pid) ?? 0;
      if (age !== 0) rememberIncarnation(priorProtected, pid, age);
    }
    // Recorded from the same snapshot, and only ever added to.
    // What is kept is evidence about CLAIMS: a later row that names this pid as its parent, born after the incarnation seen here, is undecided - even if the next scan does not list the pid at all, which is precisely the case the memory exists for.
    for (const pid of undecided) {
      rememberIncarnation(priorSuspects, pid, created.get(pid) ?? 0);
    }
  }
}

function rememberIncarnation<T>(
  memory: Map<number, T[]>,
  pid: number,
  incarnation: T,
): void {
  const incarnations = memory.get(pid);
  if (incarnations === undefined) {
    memory.set(pid, [incarnation]);
  } else {
    incarnations.push(incarnation);
  }
}

async function killProcessIds(
  pids: readonly number[],
  run: ProcessRunner,
): Promise<void> {
  await Promise.all(
    pids.map((pid) =>
      run("taskkill", ["/F", "/PID", String(pid)], {
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
    // Post-registration: `/Create` succeeded, so the task exists with its logon trigger whether or not this `/Run` was accepted.
    // A caller holding a host-start adoption lease honours it before surfacing this (`didServiceRegistrationCommit`) rather than refusing a child the scheduler may already be starting - an authority loss landing here included, which keeps its identity and is marked by reference.
    if (isServiceMutationAuthorityError(cause)) {
      throw markRegistrationCommitted(cause);
    }
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `schtasks /Run failed for ${taskName}: ${describeCause(cause)}`,
      details: {
        task: taskName,
        cause: describeCause(cause),
        registrationCommitted: true,
      },
      exitCode: 1,
    });
  }
  // Exit 0 from /Run only means the scheduler accepted the request.
  // Poll for post-baseline spawn evidence (pid metadata written after the run baseline, or a post-baseline bootstrap marker).
  const deadline = Date.now() + startEvidenceDeps.verifyTimeoutMs;
  try {
    while (Date.now() < deadline) {
      const evidence = await evidenceReader.collect(label.environment);
      if (evidence !== null) {
        return;
      }
      await startEvidenceDeps.sleep(startEvidenceDeps.verifyPollMs);
    }
  } catch (cause) {
    // Everything after an accepted `/Run` is post-registration, the evidence reader's own failures included (a `host.log` handle that cannot be read or closed rejects straight out of `collect`).
    // Marked by reference so the error keeps its identity; without this a lease-holding caller would cancel the lease while the scheduler may already be launching the supervisor - the exact gap the constructed timeout below closes for its own case.
    throw markRegistrationCommitted(cause);
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
      // Same post-registration classification as the `/Run` failure above: the task exists and the scheduler accepted the run; only the spawn evidence is missing.
      registrationCommitted: true,
    },
    exitCode: 1,
  });
}

/** Parse `Last Run Result` from a headerless `schtasks /Query /V /FO CSV` response. CSV's fixed output column is locale-independent, unlike the translated `Last Run Result` label from `/FO LIST`. */
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
    // Only ever reached after `/Run` was accepted on a task `/Create` made, so an authority loss here is post-registration like the `/Run` failure it is diagnosing.
    if (isServiceMutationAuthorityError(cause)) {
      throw markRegistrationCommitted(cause);
    }
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
  deps: WindowsControllerDeps,
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
  await killHostProcessTree(label, run, deps);
  // Restart reuses the verified start path (baseline + post-/Run evidence) so a stop-then-start that the scheduler accepts but never spawns fails with Last Run Result instead of a silent no-op.
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

// Returns null (rather than an empty list) when the scan could not run at all, so the caller can distinguish "verified: nothing to kill" from "unknown: PowerShell unavailable".
async function scanSlotProcessTable(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<readonly WindowsProcessTableRow[] | null> {
  try {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        buildSlotProcessTableScanScript(hostHomeDir(label.environment)),
      ],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
        tolerateNonZeroExit: true,
      },
    );
    return parseProcessTableJson(result.stdout);
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return null;
  }
}

interface SlotProcessScanOptions {
  readonly hostHome: string;
  readonly currentPid: number;
}

// Sets `$hostMatch` for the pipeline row in `$_`.
// Shared verbatim by both scans, so a change to what counts as a slot process cannot land in one and miss the other.
const SLOT_MATCH_SCRIPT_LINES: readonly string[] = [
  "    $exe = ([string]$_.ExecutablePath).ToLowerInvariant().Replace('/', '\\')",
  "    $cmd = ([string]$_.CommandLine).ToLowerInvariant().Replace('/', '\\')",
  '    $text = $exe + "`n" + $cmd',
  "    $hostMatch = $false",
  "    foreach ($path in $hostPaths) {",
  "      if ($text.Contains($path)) { $hostMatch = $true; break }",
  "    }",
];

/** One pass over the unfiltered process table. Filtering before classification drops host children whose path matches nothing. */
function buildSlotProcessTableScanScript(hostHome: string): string {
  const hostPaths = powershellStringArray(slotHostProcessPaths(hostHome));
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$hostPaths = @(${hostPaths})`,
    // Materialised once: the parent lookup and the row projection must come
    // from the same snapshot, or the ages being compared are from two reads.
    "$table = @(Get-CimInstance Win32_Process)",
    "$created = @{}",
    "foreach ($row in $table) {",
    "  if ($null -eq $row.CreationDate) { $created[[int]$row.ProcessId] = $null }",
    "  else { $created[[int]$row.ProcessId] = $row.CreationDate.ToUniversalTime() }",
    "}",
    "$rows = $table | ForEach-Object {",
    ...SLOT_MATCH_SCRIPT_LINES,
    ...PARENT_EDGE_VALIDATION_SCRIPT_LINES,
    ...ROW_CREATION_SCRIPT_LINES,
    "    [pscustomobject]@{",
    "      ProcessId = [int]$_.ProcessId",
    "      ParentProcessId = $parentId",
    // The id the row CLAIMS, unvalidated, alongside the validated one.
    // A process whose parent this loop killed in an earlier round has a claimed parent that is in no live table, so the validation above zeroes it - and that is precisely the row the victim carry-over has to recognise.
    "      ClaimedParentProcessId = [int]$_.ParentProcessId",
    "      Created = $createdMicros",
    "      Slot = $hostMatch",
    "    }",
    "}",
    "@($rows) | ConvertTo-Json -Compress",
  ].join("\n");
}

// `$createdMicros` is process start, not sample time. The lifetime window is decided against this.
const ROW_CREATION_SCRIPT_LINES: readonly string[] = [
  "    $createdMicros = 0",
  "    if ($null -ne $_.CreationDate) {",
  "      $createdMicros = [long][math]::Floor(($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').Ticks / 10)",
  "    }",
];

// Sets `$parentId` for the pipeline row in `$_`: the claimed parent when this snapshot can still vouch for it, and 0 when it cannot.
// A missing `CreationDate` on either end (pid 0 and System have none) is uncertainty, so it fails closed to 0 like every other unverifiable edge.
const PARENT_EDGE_VALIDATION_SCRIPT_LINES: readonly string[] = [
  "    $parentId = [int]$_.ParentProcessId",
  "    $childCreated = $null",
  "    if ($null -ne $_.CreationDate) { $childCreated = $_.CreationDate.ToUniversalTime() }",
  "    if ($parentId -le 0 -or -not $created.ContainsKey($parentId)) {",
  "      $parentId = 0",
  "    } else {",
  "      $parentCreated = $created[$parentId]",
  "      if ($null -eq $parentCreated -or $null -eq $childCreated) {",
  "        $parentId = 0",
  "      } elseif ($parentCreated -gt $childCreated) {",
  "        $parentId = 0",
  "      }",
  "    }",
];

// Same slot match as the table scan (`SLOT_MATCH_SCRIPT_LINES` is the shared text - the filter must never drift between the kill and the diagnostic), projecting name + executable path so the install swap's EBUSY error can NAME the processes still matching the slot instead of surfacing a bare errno.
// Unlike the table scan this one is a diagnostic, so it keeps its pre-filter: naming ourselves as a lock holder would be noise, not evidence.
function buildSlotProcessDetailScanScript(
  options: SlotProcessScanOptions,
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
    ...SLOT_MATCH_SCRIPT_LINES,
    "    $hostMatch",
    "  }",
    "}",
    "@($matches | Select-Object ProcessId, Name, ExecutablePath) | ConvertTo-Json -Compress",
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

// One row of the scanned process table.
export interface WindowsProcessTableRow {
  // 0 is a real, expected row: `Get-CimInstance Win32_Process` reports the
  // System Idle Process, and the scan is deliberately unfiltered.
  readonly processId: number;
  // 0 means "no VERIFIED parent" - either the row genuinely hangs off the idle process, or the scan could not vouch for the id the row claims (see the parent-edge validation in the scan script).
  // It is deliberately NOT the same thing as "the parent exited": Windows keeps the creator's id in that case, and may hand that id to somebody else, which is exactly the claim this field refuses to carry.
  readonly parentProcessId: number;
  // The parent id the row CLAIMS, with no validation applied.
  // Its only use is the cross-round carry-over: a process whose parent this loop killed - or could not place, and which has since gone - has a claimed parent that no longer appears in any table, so `parentProcessId` above is 0 and the claim is the only thing left linking the two.
  readonly claimedParentProcessId: number;
  // MICROSECONDS since the Unix epoch, or 0 when Windows reports no creation time.
  // Microseconds because the scan floors `CreationDate` to them and the carry-over compares row ages against a `Date.now()`-derived bound in the same unit - a truncation to milliseconds on one side of that comparison would round a child's birth back below its parent's.
  readonly created: number;
  // Whether the row's executable path or command line matches this slot.
  readonly slot: boolean;
}

/** Parse the table scan's output, or `null` if ANY row is not the shape this module asked for. All-or-nothing on purpose. */
function parseProcessTableJson(
  stdout: string,
): readonly WindowsProcessTableRow[] | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // `ConvertTo-Json` on a pipeline still emits a bare object for a single row
  // on Windows PowerShell 5.1 - accept both shapes, like the detail parser.
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const rows: WindowsProcessTableRow[] = [];
  const seenProcessIds = new Set<number>();
  for (const value of values) {
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const processId = record.ProcessId;
    const parentProcessId = record.ParentProcessId;
    const claimedParentProcessId = record.ClaimedParentProcessId;
    const created = record.Created;
    const slot = record.Slot;
    // Every id is accepted at zero and above.
    // The table is unfiltered, so it legitimately contains pid 0 (the System Idle Process) and rows with no verified parent; rejecting either would fail the WHOLE parse on every real machine and silently refuse every stop on the machine.
    if (
      !isProcessTableId(processId) ||
      !isProcessTableId(parentProcessId) ||
      !isProcessTableId(claimedParentProcessId) ||
      !isProcessTableId(created) ||
      typeof slot !== "boolean"
    ) {
      return null;
    }
    // A pid twice in one snapshot is not a table this code can reason over: the parent map, the child map and the age lookup would each silently keep a different one of the duplicates depending on iteration order, and the kill set would depend on which.
    // `Get-CimInstance` cannot produce it, so a response that does is malformed - and malformed is refused whole, exactly like every other shape violation above.
    if (seenProcessIds.has(processId)) return null;
    seenProcessIds.add(processId);
    rows.push({
      processId,
      parentProcessId,
      claimedParentProcessId,
      created,
      slot,
    });
  }
  return rows;
}

/** victims = slot U descendants(slot); spared = cli U descendants(cli) U (ancestors(cli) - slot); kill = victims - spared. `cliPid` is the CLI's own pid, not PowerShell's. */
export function computeWindowsHostKillSet(
  table: readonly WindowsProcessTableRow[],
  cliPid: number,
  memory: WindowsKillMemory,
): WindowsHostKillSet {
  const children = new Map<number, number[]>();
  const parents = new Map<number, number>();
  const slot = new Set<number>();
  for (const row of table) {
    parents.set(row.processId, row.parentProcessId);
    const siblings = children.get(row.parentProcessId);
    if (siblings === undefined) {
      children.set(row.parentProcessId, [row.processId]);
    } else {
      siblings.push(row.processId);
    }
    if (row.slot) slot.add(row.processId);
  }
  const seeds = new Set<number>(slot);
  const undecided = new Set<number>();
  for (const row of table) {
    const claim = classifyCarryOverClaim(row, memory);
    if (claim === "seed") seeds.add(row.processId);
    else if (claim === "unattributed") undecided.add(row.processId);
  }
  // Seeded from LIVE rows only.
  // A victim's own pid is deliberately never seeded: it is dead, so a row bearing it again is a different process wearing a recycled id, and killing it is the exact mistake this whole scan exists to avoid.
  const victims = withDescendants(seeds, children);
  const suspects = withDescendants(undecided, children);
  // The CLI's own branch: itself and everything under it over validated edges.
  // Positively identified, and never the host's - it is this process's scan and kill subprocesses.
  const cliBranch = withDescendants(new Set([cliPid]), children);
  const spared = new Set(cliBranch);
  // The CLI's non-slot ancestors are spared from the kill, and the ones the scan has placed in the host's tree are ALSO reported as lineage to remember.
  // A shell the host spawned to run the CLI is a host descendant whose other children are the host's; it is never killed, so the kill bookkeeping never records it, and it is under no obligation to outlive the loop - a child it spawns after this scan arrives, once it has exited, claiming a pid nothing else remembers.
  const ancestors = new Set<number>(ancestorsOf(cliPid, parents));
  for (const row of table) {
    if (row.created === 0 || cliBranch.has(row.processId)) continue;
    const incarnations = memory.protectedAncestors.get(row.processId);
    if (incarnations !== undefined && incarnations.includes(row.created)) {
      ancestors.add(row.processId);
    }
  }
  const protectedAncestors: number[] = [];
  for (const ancestor of ancestors) {
    if (slot.has(ancestor)) continue;
    spared.add(ancestor);
    if (victims.has(ancestor)) protectedAncestors.push(ancestor);
  }
  protectedAncestors.sort((left, right) => left - right);
  const kill = [...victims]
    .filter((pid) => !spared.has(pid))
    .sort((left, right) => left - right);
  // Remember kills and placed ancestors with a lifetime window; parent edges die when the parent does.
  const remembered = new Set([...kill, ...protectedAncestors]);
  const undecidedClosure = [...suspects]
    .filter((pid) => !remembered.has(pid) && !cliBranch.has(pid))
    .sort((left, right) => left - right);
  return {
    kill,
    protectedAncestors,
    undecided: undecidedClosure,
    // The uncertain ancestors are spared from the REPORT.
    // A protected row that happens to claim a victim pid is not an open question about the host - it is a process we have already decided never to kill - and reporting it would fail every stop issued from a Traycer-hosted terminal.
    unattributed: undecidedClosure.filter((pid) => !spared.has(pid)),
  };
}

/** Scan outcome split by what it can prove. Undecided subtrees are spared and are not convergence. */
export interface WindowsHostKillSet {
  readonly kill: readonly number[];
  readonly protectedAncestors: readonly number[];
  readonly undecided: readonly number[];
  readonly unattributed: readonly number[];
}

/** A pid this loop has placed in the host's tree - killed, or spared as one of the CLI's own ancestors - and the interval in which that pid demonstrably belonged to that process. `seenAliveAt` is the clock sampled once per round, in epoch microseconds, BEFORE the scan that selects the round's victims runs. */
export interface WindowsKillVictim {
  readonly created: number;
  readonly seenAliveAt: number;
}

/** Memory of earlier rounds is the only parent-edge evidence after a kill. */
export interface WindowsKillMemory {
  readonly victims: ReadonlyMap<number, readonly WindowsKillVictim[]>;
  readonly suspects: ReadonlyMap<number, readonly number[]>;
  // This CLI's own ancestors by identity - pid to the creation time of each incarnation an earlier round saw as an ancestor.
  // A later row with that pid AND that creation time is the same process, and stays spared even when the live edges that proved its ancestry are gone.
  readonly protectedAncestors: ReadonlyMap<number, readonly number[]>;
}

// How a row that claims a remembered pid as its parent is classified.
// "seed" - born inside the victim's proven lifetime; kill it.
type CarryOverClaim = "seed" | "unattributed" | "none";

// Lifetime-window claim: a row whose parent was a remembered victim and whose birth falls inside that victim's life is a descendant.
function classifyCarryOverClaim(
  row: WindowsProcessTableRow,
  memory: WindowsKillMemory,
): CarryOverClaim {
  if (row.parentProcessId !== 0) return "none";
  let claim: CarryOverClaim = "none";
  for (const victim of memory.victims.get(row.claimedParentProcessId) ?? []) {
    claim = strongerClaim(claim, classifyAgainstVictim(row.created, victim));
  }
  for (const suspectCreated of memory.suspects.get(
    row.claimedParentProcessId,
  ) ?? []) {
    claim = strongerClaim(
      claim,
      classifyAgainstSuspect(row.created, suspectCreated),
    );
  }
  return claim;
}

const CLAIM_STRENGTH: Readonly<Record<CarryOverClaim, number>> = {
  none: 0,
  unattributed: 1,
  seed: 2,
};

// "seed" outranks "unattributed" outranks "none": a proof beats an open
// question beats the absence of one.
function strongerClaim(
  left: CarryOverClaim,
  right: CarryOverClaim,
): CarryOverClaim {
  return CLAIM_STRENGTH[right] > CLAIM_STRENGTH[left] ? right : left;
}

// A claim on a pid this loop killed is decided by a lifetime window, not by the live parent edge (that edge is already gone).
function classifyAgainstVictim(
  created: number,
  victim: WindowsKillVictim,
): CarryOverClaim {
  // An unreadable age on either side leaves nothing to compare.
  // This is checked before the lower bound because 0 would pass it - a row of age 0 is older than every real victim - and "we could not read an age" must not be allowed to masquerade as the proof that clears a claim.
  if (victim.created === 0 || created === 0) return "unattributed";
  if (created < victim.created) return "none";
  if (created <= victim.seenAliveAt) return "seed";
  return "unattributed";
}

// A claim on a pid this loop could not place.
// Uncertainty is inherited: a process whose parent we cannot tie to the slot cannot itself be tied to the slot, and cannot be ruled out of it either.
function classifyAgainstSuspect(
  created: number,
  suspectCreated: number,
): CarryOverClaim {
  if (suspectCreated === 0 || created === 0) return "unattributed";
  if (created < suspectCreated) return "none";
  return "unattributed";
}

/** The same kill set, ordered so a process is issued its `taskkill` before its ancestors are. Cheap, and it shrinks the window in which a parent is already gone while its child is not yet reaped. */
export function orderWindowsKillsDescendantsFirst(
  pids: readonly number[],
  table: readonly WindowsProcessTableRow[],
): readonly number[] {
  const parents = new Map<number, number>();
  for (const row of table) parents.set(row.processId, row.parentProcessId);
  const depthOf = (pid: number): number => {
    let depth = 0;
    const seen = new Set<number>([pid]);
    let cursor = pid;
    for (;;) {
      const parent = parents.get(cursor);
      if (parent === undefined || parent <= 0 || seen.has(parent)) return depth;
      seen.add(parent);
      depth += 1;
      cursor = parent;
    }
  };
  const depths = new Map<number, number>();
  for (const pid of pids) depths.set(pid, depthOf(pid));
  // Ties broken by pid so the order is total: a partially-ordered kill list
  // would make the argv pins below flake on Map iteration order.
  return [...pids].sort(
    (left, right) =>
      (depths.get(right) ?? 0) - (depths.get(left) ?? 0) || left - right,
  );
}

// The seeds plus everything under them, walked over the snapshot's own parent edges.
// Traversal order is immaterial to a closure; `seen` is what matters, doubling as the cycle guard a torn table would otherwise turn into a hang.
function withDescendants(
  seeds: ReadonlySet<number>,
  children: ReadonlyMap<number, readonly number[]>,
): Set<number> {
  const seen = new Set<number>(seeds);
  const pending: number[] = [...seeds];
  for (;;) {
    const current = pending.pop();
    if (current === undefined) return seen;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      pending.push(child);
    }
  }
}

// The chain above `pid`, nearest first.
// Stops at 0 - which the scan emits for any parent it could not vouch for, so an unverified edge ends the walk rather than extending it - and at any pid already on the chain.
function ancestorsOf(
  pid: number,
  parents: ReadonlyMap<number, number>,
): readonly number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let cursor = pid;
  for (;;) {
    const parent = parents.get(cursor);
    if (parent === undefined || parent <= 0 || seen.has(parent)) return chain;
    seen.add(parent);
    chain.push(parent);
    cursor = parent;
  }
}

function isProcessTableId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function uniqueProcessIds(values: readonly number[]): readonly number[] {
  return Array.from(new Set(values.filter(isKillableProcessId)));
}

// A slot-matching process reported by the detail scan.
// Field names mirror the installer's `SwapLockHolderProcess` so `install-lifecycle.ts` can hand these through without an adapter layer.
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
  // `ConvertTo-Json` on `@(...)` still emits a bare object for a single match on Windows PowerShell 5.1 - accept both shapes, like `parseProcessTableJson` above.
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

// The install swap's between-retry escalation (installer `SwapLockRecovery.killLingeringProcesses`): re-run the same verified kill `stopService` already performed.
// The first kill ran before the swap; anything the rename now trips over either outlived it (an orphan re-matching the scan) or spawned since, and both answer to another pass.
export async function killLingeringSlotProcesses(
  label: ServiceLabel,
  runner: ProcessRunner | null,
  deps: WindowsControllerDeps,
): Promise<void> {
  await killHostProcessTree(label, runner ?? runCommand, deps);
}

// The install swap's post-mortem (`SwapLockRecovery.describeLockHolders`): name the processes the slot scan still matches after the rename retries exhausted.
// Best-effort - a scan that cannot run reports no holders rather than failing the caller, which is already surfacing an error.
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

// Quote a token the way CommandLineToArgvW splits: double quotes, doubled inner quotes.
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

/** Hidden Scheduled Task launcher. Must stay lockstep with the NSIS uninstall macro. */
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
    // The CLI prints the nonce with a trailing newline.
    // VBScript `Trim` strips SPACES only, and a VBScript RegExp `$` (no Multiline) does not match before a trailing LF, so `Trim(...)` alone left a 37-char string the pattern below rejected: every task-managed start ran `host start` WITHOUT `--adoption-nonce`, the supervisor refused the still-valid grant until it expired (~60 s), and install / restart / update all reported failure while the host came up a minute later.
    '      If nonceProbe.ExitCode = 0 Then adoptionNonce = Trim(Replace(Replace(nonceProbe.StdOut.ReadAll, vbCr, ""), vbLf, ""))',
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
    // Exit 75 is the CLI's restart-into-refreshed-slot signal (see EXIT_RESTART_INTO_REFRESHED_SLOT in index.ts): the supervised entry just replaced the slot binary and wants to be relaunched from it.
    // On systemd and launchd the service manager does that relaunch; Task Scheduler's only knob is RestartOnFailure - minute-granularity, three attempts, and whether a nonzero action exit even counts as a "failure" is an OS semantic nothing here can pin down.
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
  // Task Scheduler shows console-subsystem executables launched directly from an interactive task.
  // Use the GUI Windows Script Host as the root process, then have the generated launcher run the CLI hidden.
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

// Resolve the Task XML `<UserId>` value. schtasks requires a fully qualified `<domain>\<name>` for domain-joined machines and accepts a bare `<name>` for local accounts.
// We can't easily distinguish the two from inside Node without Win32 API calls, so we lean on the env vars that the shell sets at logon: - USERDOMAIN + USERNAME both set, non-empty → `<domain>\<name>` - USERNAME only → bare `<name>` (local-account path) - neither → fail closed; missing identity would produce a Task XML that schtasks rejects with a confusing error TODO(microsoft-account-sid): For users signed in with a Microsoft account, Windows exposes the identity as a SID (`S-1-12-1-...`) reached through the LookupAccountName / NetUserGetInfo Win32 APIs.
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
  buildSlotProcessTableScanScript as buildWindowsSlotProcessTableScanScript,
  buildSlotProcessDetailScanScript as buildWindowsSlotProcessDetailScanScript,
  parseProcessTableJson as parseWindowsProcessTableJson,
  parseProcessDetailJson as parseWindowsProcessDetailJson,
};
