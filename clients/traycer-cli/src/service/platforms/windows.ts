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
  // Set the moment `/Create` returns: from here the task exists with its
  // logon trigger, and any throw - the staging cleanup below included, whose
  // default verifies mutation authority first - is post-registration and must
  // reach a lease-holding caller as such (`didServiceRegistrationCommit`).
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
  // Staging cleanup runs whether `/Create` succeeded or not, and it runs
  // BEFORE the `/Create` failure is classified, because the two outcomes are
  // ranked: an authority loss observed here outranks a `/Create` failure.
  //
  // Removing the staging directory is best effort - a leftover temp dir
  // changes nothing about the task - so an ordinary filesystem failure is
  // logged and swallowed. That is what lets a `/Create` failure stay the
  // error the operator sees, and after a successful `/Create` it is what lets
  // a committed registration go on to its `/Run` verification.
  //
  // An authority loss is different: it is NOT about this directory. The
  // default cleanup verifies mutation authority before touching anything, and
  // a revoked lease must reach the lease-holding caller whatever step observed
  // it - deliberately even when `/Create` also failed, since "may not mutate
  // at all" is the more fundamental fact of the two. After `/Create` succeeded
  // it is post-registration, and every post-registration throw is marked
  // (`didServiceRegistrationCommit`), by reference so the error keeps its
  // identity. Thrown from here rather than from a `finally` so the ranking is
  // explicit in the control flow instead of relying on a `finally` throw
  // replacing an in-flight one.
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
      message: `schtasks /Create failed for ${taskName}: ${describeCause(createFailure)}`,
      details: { task: taskName, cause: describeCause(createFailure) },
      exitCode: 1,
    });
  }
  // Registration is also the recovery launch. Verify this exact `/Run` so
  // callers never baseline after it and mistake IgnoreNew's suppressed second
  // run for a failed repair.
  await runTaskAndVerifyStart(options.label, run);
}

/**
 * Remove the staging directory, returning the ONE failure that outranks
 * whatever the caller is in the middle of: a mutation-authority loss.
 * Every other failure is best effort and swallowed here - see the caller.
 */
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
// is genuinely still the host.
//
// There is no unverified fallback. An unreadable scan used to degrade to
// `taskkill` on the pid.json pid, which is both weaker than it looks (Windows
// may have recycled that pid for an unrelated process) and, worse, silent: the
// caller went on to delete the pid metadata and report the host stopped while
// descendants the fallback never enumerated kept running and kept the install
// dir open. Every exit below therefore either PROVES the slot is empty with a
// scan or throws. Refusing before anything is killed is the safer half of that
// trade: a stop that cannot be verified leaves the tree whole for the next
// attempt instead of half torn down.
//
// NEVER `/T`. This CLI is routinely a CHILD of the host it is stopping - a
// maintenance RPC, the reconciler, or a person's command in a Traycer-hosted
// terminal - and `taskkill /T` walks down from the host and kills it mid-update:
// the host is gone, the updater is gone, and nothing finishes the swap. The
// scan computes which pids to kill (`computeWindowsHostKillSet`) and each one is
// killed individually, deepest first (`orderWindowsKillsDescendantsFirst`) so a
// child is issued its kill before the parent whose death would orphan it. That
// ordering is a courtesy, not a mechanism - the kills are issued concurrently,
// and what actually catches a process spawned mid-kill is the victim carry-over
// below. `taskkill /F` on a parent leaves its children running, the VBS launcher
// re-runs the host only on exit 75 (the refreshed-slot signal) and never after a
// kill, and the CLI-side supervisor is already silenced by the stop intent
// written before any of this.
//
// Not `/T` also means nothing sweeps up what is spawned DURING the kill. The
// scan is a snapshot, so a child the host or one of its agents starts after
// `Get-CimInstance` materializes the table is in no round's kill set; killing
// its parent orphans it, and the caller goes on to delete the pid metadata
// while it still holds the install dir open. So this rescans and kills again
// until a scan comes back empty. Each round kills exactly what THAT round's
// scan returned - the scan verifies by exe path/command line, so a pid Windows
// recycled between rounds is simply not in it.
//
// `WINDOWS_KILL_CONVERGENCE_ROUNDS` counts KILL passes, so the loop scans one
// more time than it kills: the last scan is always a confirming one, and an
// empty scan is the ONLY way out that reports success.
//
// Known and deliberately not mechanised: `taskkill /F` is `TerminateProcess`,
// which is asynchronous - the confirming scan can briefly still list a pid the
// previous round killed. The bound absorbs one such round (that pid is gone by
// the next scan and the loop converges normally). If the live Windows run shows
// this flaking, the lever is a short settle before the re-scan, NOT a wider
// bound: more rounds would only spend more time re-killing the same pids.
async function killHostProcessTree(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  // What earlier rounds killed, with the age each had when it was killed. The
  // loop's memory: once a parent is dead the table can no longer prove its
  // children belong to the slot, and this is the only thing that still can.
  const priorVictims = new Map<number, number>();
  for (let round = 0; round <= WINDOWS_KILL_CONVERGENCE_ROUNDS; round += 1) {
    const table = await scanSlotProcessTable(label, run);
    if (table === null) {
      // Before the first kill this refuses to start; after one it refuses to
      // claim the tree came down. Both are the same statement - we cannot see
      // the slot, so we cannot say what is in it - and neither may be softened
      // into a success the caller would act on by purging pid.json.
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message:
          `could not enumerate the ${label.id} host process tree: the PowerShell process scan failed or timed out. ` +
          "Refusing to report the host stopped. Retry, or end the Traycer host processes from Task Manager.",
        details: { label: label.id, killRoundsCompleted: round },
        exitCode: 1,
      });
    }
    // The kill boundary, and the only place a pid has to be POSITIVE: the scan
    // and its algebra work over an unfiltered table that includes pid 0, and
    // `isKillableProcessId` is what keeps 0 - and our own pid - out of an argv.
    const pids = uniqueProcessIds(
      computeWindowsHostKillSet(table, process.pid, priorVictims),
    );
    // Converged, and the only success: a scan taken AFTER the previous round's
    // kills found nothing left in this slot. Round 0 reaches here whenever
    // there was never anything to kill, which is the ordinary stop of a host
    // that already exited - one scan, no kills.
    if (pids.length === 0) return;
    // Out of kill passes with the slot still occupied. Falling through here
    // would report exactly what a converged scan reports, which is the one
    // thing this function must never do: name the survivors instead, so the
    // caller's error says which processes to deal with.
    if (round === WINDOWS_KILL_CONVERGENCE_ROUNDS) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message:
          `${label.id} host processes are still running after ${WINDOWS_KILL_CONVERGENCE_ROUNDS} kill rounds (pids ${pids.join(", ")}). ` +
          "Retry, or end them from Task Manager.",
        details: {
          label: label.id,
          survivingPids: pids,
          killRounds: WINDOWS_KILL_CONVERGENCE_ROUNDS,
        },
        exitCode: 1,
      });
    }
    await killProcessIds(orderWindowsKillsDescendantsFirst(pids, table), run);
    // Remembered AFTER the kill, from the snapshot the kill was computed from,
    // so each victim's age is the one it had while it was alive. A row is
    // always in the table it was selected from, so the fallback age is
    // unreachable; 0 is the value the next round refuses to link anything to,
    // which is the right way for it to be wrong.
    const created = new Map(table.map((row) => [row.processId, row.created]));
    for (const pid of pids) priorVictims.set(pid, created.get(pid) ?? 0);
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
    // Post-registration: `/Create` succeeded, so the task exists with its
    // logon trigger whether or not this `/Run` was accepted. A caller holding
    // a host-start adoption lease honours it before surfacing this
    // (`didServiceRegistrationCommit`) rather than refusing a child the
    // scheduler may already be starting - an authority loss landing here
    // included, which keeps its identity and is marked by reference.
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
  // Exit 0 from /Run only means the scheduler accepted the request. Poll
  // for post-baseline spawn evidence (pid metadata written after the run
  // baseline, or a post-baseline bootstrap marker). On none, surface the
  // task's Last Run Result so Retry can escalate to a task rewrite.
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
    // Everything after an accepted `/Run` is post-registration, the evidence
    // reader's own failures included (a `host.log` handle that cannot be
    // read or closed rejects straight out of `collect`). Marked by reference
    // so the error keeps its identity; without this a lease-holding caller
    // would cancel the lease while the scheduler may already be launching
    // the supervisor - the exact gap the constructed timeout below closes
    // for its own case.
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
      // Same post-registration classification as the `/Run` failure above:
      // the task exists and the scheduler accepted the run; only the spawn
      // evidence is missing.
      registrationCommitted: true,
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
    // Only ever reached after `/Run` was accepted on a task `/Create` made,
    // so an authority loss here is post-registration like the `/Run` failure
    // it is diagnosing.
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

// Sets `$hostMatch` for the pipeline row in `$_`. Shared verbatim by both
// scans, so a change to what counts as a slot process cannot land in one and
// miss the other.
const SLOT_MATCH_SCRIPT_LINES: readonly string[] = [
  "    $exe = ([string]$_.ExecutablePath).ToLowerInvariant().Replace('/', '\\')",
  "    $cmd = ([string]$_.CommandLine).ToLowerInvariant().Replace('/', '\\')",
  '    $text = $exe + "`n" + $cmd',
  "    $hostMatch = $false",
  "    foreach ($path in $hostPaths) {",
  "      if ($text.Contains($path)) { $hostMatch = $true; break }",
  "    }",
];

/**
 * ONE pass over the UNFILTERED process table, projected to what the kill set is
 * computed from: the pid, its parent, and whether the row matches this slot.
 *
 * Unfiltered is the point. The old scan excluded this process before the
 * projection ran and returned bare pids, so it could not answer the only
 * question that matters here - which of the slot's processes are ABOVE this CLI
 * rather than beside it. Parent ids and slot matches now come from the same
 * snapshot, which is what bounds pid reuse between the two reads.
 *
 * The script knows nothing about who we are: no `$excluded`, and emphatically
 * no `$PID` - PowerShell is this CLI's own child, so its `$PID` is not the CLI
 * and using it as "self" spares the wrong branch of the tree. Self-identity is
 * `computeWindowsHostKillSet`'s input, applied to the table in-process.
 *
 * Command lines are matched inside the script and never leave it: they can name
 * arbitrary user data, and the caller needs three fields per row, not a copy of
 * the machine's process table.
 *
 * PARENT IDS ARE VALIDATED HERE, against `CreationDate` from this same read.
 * Windows does not clear `ParentProcessId` when the parent exits - the row keeps
 * the creator's id, and Windows is free to hand that id to an unrelated process
 * afterwards. Believing such an id would attach a stranger to the host's subtree
 * and force-kill it, or attach the CLI to a recycled ancestor and spare a
 * process that should die. A snapshot cannot undo reuse that already happened,
 * but it can refuse to trust it: an edge survives only when the claimed parent
 * is still in the table AND is not younger than its claimed child. Everything
 * else is emitted as parent 0, which the kill-set algebra reads as "no verified
 * parent" - never as an edge.
 */
function buildSlotProcessTableScanScript(hostHome: string): string {
  const hostPaths = powershellStringArray(slotHostProcessPaths(hostHome));
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$hostPaths = @(${hostPaths})`,
    // Materialised once: the parent lookup and the row projection must come
    // from the same snapshot, or the ages being compared are from two reads.
    "$table = @(Get-CimInstance Win32_Process)",
    "$created = @{}",
    "foreach ($row in $table) { $created[[int]$row.ProcessId] = $row.CreationDate }",
    "$rows = $table | ForEach-Object {",
    ...SLOT_MATCH_SCRIPT_LINES,
    ...PARENT_EDGE_VALIDATION_SCRIPT_LINES,
    ...ROW_CREATION_SCRIPT_LINES,
    "    [pscustomobject]@{",
    "      ProcessId = [int]$_.ProcessId",
    "      ParentProcessId = $parentId",
    // The id the row CLAIMS, unvalidated, alongside the validated one. A
    // process whose parent this loop killed in an earlier round has a claimed
    // parent that is in no live table, so the validation above zeroes it - and
    // that is precisely the row the victim carry-over has to recognise.
    "      ClaimedParentProcessId = [int]$_.ParentProcessId",
    "      Created = $createdMs",
    "      Slot = $hostMatch",
    "    }",
    "}",
    "@($rows) | ConvertTo-Json -Compress",
  ].join("\n");
}

// Sets `$createdMs` for the pipeline row in `$_`: how old the process is, as
// milliseconds since the Unix epoch, and 0 when Windows reports no creation
// time at all (pid 0 and System have none). Milliseconds rather than the native
// FILETIME because a FILETIME is ~1.3e17 - past the point where JSON numbers
// stay exact - while epoch milliseconds is ~1.7e12 and survives the round trip
// intact. The unit only ever gets COMPARED, never displayed, so its precision
// just has to beat the gap between a parent and the child it forks.
const ROW_CREATION_SCRIPT_LINES: readonly string[] = [
  "    $createdMs = 0",
  "    if ($null -ne $_.CreationDate) {",
  "      $createdMs = [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds",
  "    }",
];

// Sets `$parentId` for the pipeline row in `$_`: the claimed parent when this
// snapshot can still vouch for it, and 0 when it cannot. A missing
// `CreationDate` on either end (pid 0 and System have none) is uncertainty, so
// it fails closed to 0 like every other unverifiable edge.
const PARENT_EDGE_VALIDATION_SCRIPT_LINES: readonly string[] = [
  "    $parentId = [int]$_.ParentProcessId",
  "    $childCreated = $_.CreationDate",
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

// Same slot match as the table scan (`SLOT_MATCH_SCRIPT_LINES` is the shared
// text - the filter must never drift between the kill and the diagnostic),
// projecting name + executable path so the install swap's EBUSY error can NAME
// the processes still matching the slot instead of surfacing a bare errno.
// Unlike the table scan this one is a diagnostic, so it keeps its pre-filter:
// naming ourselves as a lock holder would be noise, not evidence.
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
  // 0 means "no VERIFIED parent" - either the row genuinely hangs off the idle
  // process, or the scan could not vouch for the id the row claims (see the
  // parent-edge validation in the scan script). It is deliberately NOT the same
  // thing as "the parent exited": Windows keeps the creator's id in that case,
  // and may hand that id to somebody else, which is exactly the claim this
  // field refuses to carry.
  readonly parentProcessId: number;
  // The parent id the row CLAIMS, with no validation applied. Its only use is
  // the cross-round victim carry-over: a process whose parent this loop killed
  // has a claimed parent that no longer appears in any table, so
  // `parentProcessId` above is 0 and the claim is the only thing left linking
  // the two. Never treat it as an edge on its own - `created` is what makes it
  // safe (see `computeWindowsHostKillSet`).
  readonly claimedParentProcessId: number;
  // Milliseconds since the Unix epoch, or 0 when Windows reports no creation
  // time. What turns a claimed parent id into evidence: a process cannot
  // predate its own parent, so an id whose claimed parent is YOUNGER than it is
  // a recycled id rather than an ancestry.
  readonly created: number;
  // Whether the row's executable path or command line matches this slot.
  readonly slot: boolean;
}

/**
 * Parse the table scan's output, or `null` if ANY row is not the shape this
 * module asked for.
 *
 * All-or-nothing on purpose. A partially-parsed table produces a kill set built
 * from a partial ancestry, and a missing edge there does not read as an error -
 * it reads as "this process has no parent", which spares nothing and kills a
 * branch that should have been spared. `null` sends the caller to the pid.json
 * fallback, which is weaker but honest about what it knows. Empty output is
 * `null` for the same reason: a real Win32_Process scan is never empty, so
 * nothing on stdout means the scan did not run.
 */
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
  for (const value of values) {
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const processId = record.ProcessId;
    const parentProcessId = record.ParentProcessId;
    const claimedParentProcessId = record.ClaimedParentProcessId;
    const created = record.Created;
    const slot = record.Slot;
    // Every id is accepted at zero and above. The table is unfiltered, so it
    // legitimately contains pid 0 (the System Idle Process) and rows with no
    // verified parent; rejecting either would fail the WHOLE parse on every
    // real machine and silently refuse every stop on the machine.
    // Deliberately NOT `isKillableProcessId` either: that also rejects our own
    // pid, which is expected in the table too. What may be killed is the
    // algebra's answer and the kill boundary's, not the parser's. `Created` is
    // held to the same shape and reads 0 for "Windows reported no creation
    // time", which the algebra treats as unusable rather than as age zero.
    if (
      !isProcessTableId(processId) ||
      !isProcessTableId(parentProcessId) ||
      !isProcessTableId(claimedParentProcessId) ||
      !isProcessTableId(created) ||
      typeof slot !== "boolean"
    ) {
      return null;
    }
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

/**
 * Which pids a host stop may kill, given the whole process table and the pid of
 * the CLI issuing the stop.
 *
 *   victims = slot ∪ descendants(slot)
 *   spared  = cli ∪ descendants(cli) ∪ (ancestors(cli) − slot)
 *   kill    = victims − spared
 *
 * The host is slot-matched AND an ancestor of a host-spawned CLI, so subtracting
 * the slot from the spared ancestors is what keeps it in the kill set: "exclude
 * the updater's ancestry" would spare the very process this stop exists to
 * terminate. What the ancestor clause actually protects is a Traycer-hosted
 * TERMINAL run, where the shell and its conpty sit between the host and this
 * CLI and match nothing.
 *
 * `cliPid` is the CLI's own pid. Not PowerShell's: the scan runs as this
 * process's child, so `$PID` inside it is a descendant of the answer, and
 * seeding from it spares the branch above the CLI while leaving the CLI's own
 * siblings - the detached upgrade finalizer among them - to be killed.
 *
 * `priorVictims` (pid -> creation time) is what the kill loop remembers from
 * its earlier rounds, and it exists because killing a parent DESTROYS the
 * evidence linking its children to the slot. A process the host spawned after
 * round 0's snapshot shows up in round 1 with its parent already dead: the
 * table cannot vouch for that edge, so the row arrives with `parentProcessId`
 * 0, and if the child is a shell or a provider binary its own path matches
 * nothing. It would be an orphan the loop calls convergence on. A row whose
 * CLAIMED parent is a remembered victim is therefore treated as a descendant of
 * a verified slot process - seeded, not merely walked to.
 *
 * Creation time is what keeps that safe against pid reuse: a child cannot
 * predate its own parent, so a row claiming a recycled victim id is rejected
 * the moment it turns out to be OLDER than the victim was. An unknown creation
 * time on either end (0) is refused rather than assumed, which is the same way
 * the scan script treats an age it cannot read.
 */
export function computeWindowsHostKillSet(
  table: readonly WindowsProcessTableRow[],
  cliPid: number,
  priorVictims: ReadonlyMap<number, number>,
): readonly number[] {
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
  for (const row of table) {
    if (isChildOfVictim(row, priorVictims)) seeds.add(row.processId);
  }
  // Seeded from LIVE rows only. A victim's own pid is deliberately never seeded:
  // it is dead, so a row bearing it again is a different process wearing a
  // recycled id, and killing it is the exact mistake this whole scan exists to
  // avoid.
  const victims = withDescendants(seeds, children);
  const spared = withDescendants(new Set([cliPid]), children);
  for (const ancestor of ancestorsOf(cliPid, parents)) {
    if (!slot.has(ancestor)) spared.add(ancestor);
  }
  return [...victims]
    .filter((pid) => !spared.has(pid))
    .sort((left, right) => left - right);
}

// Whether this row is a child of a process an earlier kill round destroyed.
// Both ages have to be known and the parent's must not be later than the
// child's: an id whose claimed parent is YOUNGER than it cannot be its parent,
// which is what a reused pid looks like from here.
function isChildOfVictim(
  row: WindowsProcessTableRow,
  priorVictims: ReadonlyMap<number, number>,
): boolean {
  const victimCreated = priorVictims.get(row.claimedParentProcessId);
  if (victimCreated === undefined) return false;
  if (victimCreated === 0 || row.created === 0) return false;
  return victimCreated <= row.created;
}

/**
 * The same kill set, ordered so a process is issued its `taskkill` before its
 * ancestors are. Cheap, and it shrinks the window in which a parent is already
 * gone while its child is not yet reaped.
 *
 * It does NOT replace the victim carry-over, and must not be mistaken for it:
 * the kills are issued concurrently, so this orders their ISSUE and nothing
 * more, and a process spawned after the snapshot is not in this list at all at
 * any ordering. The carry-over is what actually catches that one, a round later.
 */
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

// The seeds plus everything under them, walked over the snapshot's own parent
// edges. Traversal order is immaterial to a closure; `seen` is what matters,
// doubling as the cycle guard a torn table would otherwise turn into a hang.
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

// The chain above `pid`, nearest first. Stops at 0 - which the scan emits for
// any parent it could not vouch for, so an unverified edge ends the walk rather
// than extending it - and at any pid already on the chain.
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
  // `parseProcessTableJson` above.
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
//
// This one is allowed to fail: `swapLockRetryHook` logs a refusal and lets the
// rename retry anyway (only a lost mutation authority propagates), so a stop
// that cannot be verified HERE degrades to the swap's own EBUSY reporting -
// which names the lock holders - rather than aborting a swap that may yet
// succeed.
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
  buildSlotProcessTableScanScript as buildWindowsSlotProcessTableScanScript,
  buildSlotProcessDetailScanScript as buildWindowsSlotProcessDetailScanScript,
  parseProcessTableJson as parseWindowsProcessTableJson,
  parseProcessDetailJson as parseWindowsProcessDetailJson,
};
