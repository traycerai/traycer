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

/**
 * The clock the kill loop bounds its carry-over with, in epoch MICROSECONDS -
 * the same unit and epoch the scan projects `CreationDate` into, which is the
 * only reason the two can be compared at all.
 *
 * `Date.now()` is milliseconds, so this is coarser than its unit suggests: it
 * names an instant up to 999us EARLIER than the true one. That direction is the
 * safe one. The value is only ever used as an upper bound on "the victim still
 * held this pid", so being early can only refuse a row that might have been
 * attributable - never admit one that is not.
 */
export function epochMicrosNow(): number {
  return Date.now() * 1000;
}

/** Seams the kill loop needs from the outside world. */
export interface WindowsControllerDeps {
  /**
   * The current time in MICROSECONDS since the Unix epoch - the unit
   * `WindowsProcessTableRow.created` is projected in, because the kill loop
   * compares the two directly to bound each victim's lifetime. Production
   * passes `epochMicrosNow`. A caller that passed `Date.now()` (milliseconds)
   * would place every bound a thousand times too early and classify every
   * carry-over row as unattributed, failing every stop that needed one.
   */
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
    // No Desktop/SMAppService split on Windows, so the restart halves are the
    // stop and start `host restart` already performed - the named seam exists
    // so the command has one shape on every platform. `forcedRecycle` is
    // never set: `stopService` taskkills and waits, so nothing survives to
    // need a recycle.
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
  deps: WindowsControllerDeps,
): Promise<void> {
  await run("schtasks", ["/End", "/TN", windowsTaskName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: WINDOWS_SCHTASKS_END_TIMEOUT_MS,
    tolerateNonZeroExit: true,
  });
  await killHostProcessTree(label, run, deps);
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
  deps: WindowsControllerDeps,
): Promise<void> {
  // What earlier rounds placed in the host's tree - killed, or spared as one of
  // this CLI's own ancestors - with the age each had when it was seen. The
  // loop's memory: once a parent is dead the table can no longer prove its
  // children belong to the slot, and this is the only thing that still can.
  //
  // Per INCARNATION, appended and never replaced. A pid can be killed twice as
  // two different processes (the first lingers in an asynchronous
  // `TerminateProcess`, or is reused and the newcomer is slot-matched too), and
  // each kill is evidence about the rows born during THAT holder's lifetime. A
  // map that kept only the latest would let a newer holder of a pid erase what
  // the loop learned about the previous holder's children, and a row born inside
  // the older window would read as "older than the victim" - decided, and
  // wrongly, as somebody else's.
  const priorVictims = new Map<number, WindowsKillVictim[]>();
  // The other half of that memory: pids an earlier round could place neither in
  // the slot nor out of it, against the age the row wearing each one had then.
  // Uncertainty has to cross a round boundary for the same reason a kill does.
  // The row that made a pid undecided is under no obligation to still be there
  // next round - it can exit, or spawn a child and then exit - and without this
  // the child arrives as an ordinary orphan claiming a pid nothing remembers,
  // which reads as convergence. Only the age is kept: `classifyAgainstSuspect`
  // shows a suspect's upper bound cannot change any verdict. Per incarnation,
  // for the same reason as the victims: a later, unrelated holder of the pid
  // that also cannot be placed must not narrow what an earlier holder's child
  // can be suspected of.
  const priorSuspects = new Map<number, number[]>();
  // The third: this CLI's own ancestors, by IDENTITY (pid and creation time),
  // for every incarnation a round saw them as ancestors. Their windows go into
  // `priorVictims` like a kill's, which is what places their other children;
  // this is what keeps THEM protected. The live ancestor walk proves ancestry
  // only through live edges, and a wrapper between the shell and the CLI can
  // exit between rounds - the shell then sits in the table as an orphan
  // claiming a remembered pid, inside a remembered window, and would be seeded
  // and killed as an ordinary host descendant. The identity says it is the
  // same process the loop already decided never to kill; a reused pid with a
  // different birth matches nothing.
  const priorProtected = new Map<number, number[]>();
  // The triple, by reference: the maps below are mutated in place at the end
  // of every round, so this is built once and always reflects the latest round.
  const memory: WindowsKillMemory = {
    victims: priorVictims,
    suspects: priorSuspects,
    protectedAncestors: priorProtected,
  };
  for (let round = 0; round <= WINDOWS_KILL_CONVERGENCE_ROUNDS; round += 1) {
    // BEFORE the scan, and that ordering is the soundness argument for the
    // whole carry-over: every victim this round selects is one the scan below
    // observed alive, so each was still holding its pid at this instant. Read
    // after the scan - or worse, just before the kills - the bound would cover
    // time in which the victim may already have exited and its pid been reused.
    //
    // Strictly, "existed at this instant" holds for every victim the scan could
    // have observed: one BORN during the enumeration did not exist here, and
    // gets `created > seenAliveAt` - an empty window that attributes nothing to
    // it. That is the safe direction: an empty window refuses every claim on
    // that pid rather than admitting one it cannot support.
    const seenAliveAt = deps.now();
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
    const killSet = computeWindowsHostKillSet(table, process.pid, memory);
    const pids = uniqueProcessIds(killSet.kill);
    const unattributed = uniqueProcessIds(killSet.unattributed);
    const undecided = uniqueProcessIds(killSet.undecided);
    const protectedAncestors = uniqueProcessIds(killSet.protectedAncestors);
    if (pids.length === 0) {
      // Nothing left to kill - but that is only convergence if nothing is
      // UNDECIDED. A row claiming a killed host process as its parent, born
      // after that parent was last seen alive, may be a stranger wearing a
      // recycled pid or may be a host child spawned in its parent's last
      // moments. Killing it risks a stranger; ignoring it reports a stop while
      // a host process runs on and the caller goes off to delete the pid
      // metadata. Neither is ours to choose silently, so the stop fails and
      // names them - them and everything under them, since a subtree hanging
      // off an undecided process is exactly as undecided as its root.
      if (unattributed.length > 0) {
        // "Run the command again" was the wrong advice and is deliberately
        // gone, for the opposite of the obvious reason: a rerun would very
        // likely SUCCEED, and that success would prove nothing. This memory
        // is invocation-local; a fresh stop starts with no victims and no
        // suspects, so the same orphan arrives as an ordinary process with a
        // parent nobody remembers, and with no slot match left the loop
        // converges around it. The rerun cannot certify the orphan as
        // unrelated, it can only forget the question. Ending the named
        // processes is what actually changes the answer, and it is the one
        // instruction that also works when they turn out to be strangers
        // wearing recycled pids.
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
      // Converged, and the only success: a scan taken AFTER the previous
      // round's kills found nothing left in this slot and nothing undecided.
      // Round 0 reaches here whenever there was never anything to kill, which
      // is the ordinary stop of a host that already exited - one scan, no
      // kills.
      return;
    }
    // Out of kill passes with the slot still occupied. Falling through here
    // would report exactly what a converged scan reports, which is the one
    // thing this function must never do: name the survivors instead, so the
    // caller's error says which processes to deal with.
    if (round === WINDOWS_KILL_CONVERGENCE_ROUNDS) {
      // The undecided rows travel with the survivors. This exit is the one the
      // user acts on, and a list that names only what we could prove sends
      // them to Task Manager with half the slot: the pids we could not place
      // are as likely to be what is holding the install dir open, and they are
      // the ones nobody else is going to point at.
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
    // Remembered AFTER the kill, from the snapshot the kill was computed from,
    // so each victim's age is the one it had while it was alive. A row is
    // always in the table it was selected from, so the fallback age is
    // unreachable; 0 is the value the next round refuses to link anything to,
    // which is the right way for it to be wrong.
    //
    // A pid killed again in a later round gets a second entry with that
    // round's `seenAliveAt`, and the wider window is the honest bound: its
    // scan saw the pid alive too, so the interval in which the pid was
    // demonstrably still the victim's genuinely extends to there. The earlier
    // entry stays; nothing it proved has become false.
    const created = new Map(table.map((row) => [row.processId, row.created]));
    for (const pid of pids) {
      rememberIncarnation(priorVictims, pid, {
        created: created.get(pid) ?? 0,
        seenAliveAt,
      });
    }
    // The CLI's own placed ancestors go into the same map, with the same
    // window, though nothing was done to them: the shell the host spawned to
    // run this CLI is a host descendant, its other children are the host's, and
    // it can exit between rounds like anything else. A child it spawns after
    // this scan then claims its pid as an orphan, and the window is what says
    // whether that child was born while the shell was demonstrably the host's
    // (seed) or after the last time this loop saw it (undecided). Without the
    // entry the claim matches nothing and the child reads as convergence.
    for (const pid of protectedAncestors) {
      rememberIncarnation(priorVictims, pid, {
        created: created.get(pid) ?? 0,
        seenAliveAt,
      });
      // And by identity, so the next round still spares it when the edges
      // that proved its ancestry are gone. An unreadable age is no identity:
      // nothing can match it, so nothing is recorded.
      const age = created.get(pid) ?? 0;
      if (age !== 0) rememberIncarnation(priorProtected, pid, age);
    }
    // Recorded from the same snapshot, and only ever added to. What is kept is
    // evidence about CLAIMS: a later row that names this pid as its parent, born
    // after the incarnation seen here, is undecided - even if the next scan does
    // not list the pid at all, which is precisely the case the memory exists
    // for. It is not a verdict on the pid's own row: a row this round could not
    // place is re-classified from scratch next round, and a live parent whose
    // edge validates then clears it (`classifyCarryOverClaim`). A later round
    // that reaches the same pid again adds the incarnation it saw beside the
    // earlier one.
    //
    // From the FULL undecided closure, not from the reported subset. The CLI's
    // own branch is withheld from the report and the kill, but the shell above
    // the CLI is under no obligation to still be there next round, and its
    // other children then claim a pid that only this entry remembers.
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
    // The id the row CLAIMS, unvalidated, alongside the validated one. A
    // process whose parent this loop killed in an earlier round has a claimed
    // parent that is in no live table, so the validation above zeroes it - and
    // that is precisely the row the victim carry-over has to recognise.
    "      ClaimedParentProcessId = [int]$_.ParentProcessId",
    "      Created = $createdMicros",
    "      Slot = $hostMatch",
    "    }",
    "}",
    "@($rows) | ConvertTo-Json -Compress",
  ].join("\n");
}

// Sets `$createdMicros` for the pipeline row in `$_`: when the process started,
// as MICROSECONDS since the Unix epoch, and 0 when Windows reports no creation
// time at all (pid 0 and System have none).
//
// Microseconds, not milliseconds, because the carry-over compares a child's
// birth against a victim's and milliseconds are too coarse to separate them: a
// previous holder of a pid can fork a child and exit, and the replacement be
// created, well inside one millisecond - both then project to the same value
// and a `<=` comparison attributes the stranger to the victim. CIM datetimes
// carry microseconds, so the precision is really there to be used.
//
// Not the native FILETIME (~1.3e17, past exact JSON integers) and not ticks
// (100ns, ~1.7e16 - also past). Epoch microseconds is ~1.7e15, which is under
// 2^53 and survives the round trip intact. `Ticks / 10` converts a TimeSpan's
// 100ns units to microseconds; the floor keeps it an integer rather than
// letting PowerShell hand back a rounded double.
//
// `.ToUniversalTime()` for the same reason the edge validation needs it: a
// local DateTime is ambiguous across a DST fall-back, and an hour in which
// every timestamp can mean two instants is an hour in which "older" is not a
// fact. The epoch these are measured from is UTC, so the operand must be too.
const ROW_CREATION_SCRIPT_LINES: readonly string[] = [
  "    $createdMicros = 0",
  "    if ($null -ne $_.CreationDate) {",
  "      $createdMicros = [long][math]::Floor(($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').Ticks / 10)",
  "    }",
];

// Sets `$parentId` for the pipeline row in `$_`: the claimed parent when this
// snapshot can still vouch for it, and 0 when it cannot. A missing
// `CreationDate` on either end (pid 0 and System have none) is uncertainty, so
// it fails closed to 0 like every other unverifiable edge.
//
// BOTH operands are normalised to UTC before they are compared. `CreationDate`
// arrives as a local DateTime, and local time is not monotonic: across a DST
// fall-back the same wall-clock hour happens twice, so a process started in the
// second pass can compare as OLDER than one started in the first. That is not a
// cosmetic ordering error here - it is an edge this scan would then VALIDATE,
// attaching a stranger to a slot process and putting it in the kill set.
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
  // the cross-round carry-over: a process whose parent this loop killed - or
  // could not place, and which has since gone - has a claimed parent that no
  // longer appears in any table, so `parentProcessId` above is 0 and the claim
  // is the only thing left linking the two. Never treat it as an edge on its
  // own - `created` is what makes it safe (see `computeWindowsHostKillSet`).
  readonly claimedParentProcessId: number;
  // MICROSECONDS since the Unix epoch, or 0 when Windows reports no creation
  // time. Microseconds because the scan floors `CreationDate` to them and the
  // carry-over compares row ages against a `Date.now()`-derived bound in the
  // same unit - a truncation to milliseconds on one side of that comparison
  // would round a child's birth back below its parent's. What turns a claimed
  // parent id into evidence: a process cannot predate its own parent, so an id
  // whose claimed parent is YOUNGER than it is a recycled id, not an ancestry.
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
  const seenProcessIds = new Set<number>();
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
    // A pid twice in one snapshot is not a table this code can reason over: the
    // parent map, the child map and the age lookup would each silently keep a
    // different one of the duplicates depending on iteration order, and the kill
    // set would depend on which. `Get-CimInstance` cannot produce it, so a
    // response that does is malformed - and malformed is refused whole, exactly
    // like every other shape violation above.
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
 * `memory` is what the kill loop remembers from its earlier rounds. Its victims
 * exist because killing a parent DESTROYS the evidence linking its children to
 * the slot. A process the host spawned after round 0's snapshot shows up in
 * round 1 with its parent already dead: the table cannot vouch for that edge, so
 * the row arrives with `parentProcessId` 0, and if the child is a shell or a
 * provider binary its own path matches nothing. It would be an orphan the loop
 * calls convergence on. A row whose CLAIMED parent is a remembered victim, and
 * whose birth falls inside that victim's known lifetime, is therefore treated as
 * a descendant of a verified slot process - seeded, not merely walked to. See
 * `classifyAgainstVictim` for why a lifetime, and why a claim that falls outside
 * it is reported rather than decided.
 *
 * Its suspects are the same memory for rows an earlier round could not place.
 * They carry no verdict, only the fact that the pid is in question: a row
 * claiming one is undecided too (`classifyAgainstSuspect`), because deciding it
 * would mean deciding its parent, which is the thing this loop already said it
 * could not do.
 *
 * `undecided` carries those undecidable rows out to the caller, TOGETHER WITH
 * EVERYTHING BELOW THEM, walked over the same validated edges as the kill set.
 * An undecided root makes its whole subtree undecided - those children are
 * verified children of a process we cannot place, so they are exactly as
 * unplaceable - and naming only the root would send the caller after one pid
 * while the rest of the branch keeps the install dir open. They are all spared
 * from `kill` (killing on a claim we cannot verify is the mistake this scan
 * exists to prevent), and the loop must not read their absence from `kill` as
 * convergence, because a host child spawned just before its parent died looks
 * exactly like this.
 *
 * Precisely: `undecided` is that closure minus everything the loop is about to
 * remember with a window (`kill` and `protectedAncestors`) and minus the CLI's
 * own descendant branch, which is positively identified and never the host's
 * even when its slot-matched scan lands in the closure under an undecided CLI.
 * `unattributed` is `undecided` minus the CLI's uncertain ancestors as well -
 * what the loop reports, as opposed to what it remembers.
 */
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
  // Seeded from LIVE rows only. A victim's own pid is deliberately never seeded:
  // it is dead, so a row bearing it again is a different process wearing a
  // recycled id, and killing it is the exact mistake this whole scan exists to
  // avoid.
  const victims = withDescendants(seeds, children);
  const suspects = withDescendants(undecided, children);
  // The CLI's own branch: itself and everything under it over validated edges.
  // Positively identified, and never the host's - it is this process's scan
  // and kill subprocesses.
  const cliBranch = withDescendants(new Set([cliPid]), children);
  const spared = new Set(cliBranch);
  // The CLI's non-slot ancestors are spared from the kill, and the ones the
  // scan has placed in the host's tree are ALSO reported as lineage to
  // remember. A shell the host spawned to run the CLI is a host descendant
  // whose other children are the host's; it is never killed, so the kill
  // bookkeeping never records it, and it is under no obligation to outlive the
  // loop - a child it spawns after this scan arrives, once it has exited,
  // claiming a pid nothing else remembers. Ancestors only: the CLI's own
  // descendants are its scan and kill subprocesses, and nothing below them is
  // ever the host's.
  //
  // Two ways to be an ancestor: the live edge walk from the CLI, and a
  // remembered IDENTITY - the same pid with the same creation time an earlier
  // round saw as an ancestor, now orphaned because a wrapper between it and the
  // CLI has exited. The second is what keeps a shell protected after its
  // ancestry can no longer be walked; without it the shell, claiming a
  // remembered pid inside a remembered window, is seeded and killed as an
  // ordinary host descendant. A row that is slot-matched THIS round is killed
  // either way, and a reused pid with a different birth matches nothing.
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
  // What is remembered with a lifetime window: the kills, and the placed
  // ancestors. Both drop out of the undecided lists - a subtree can hang off an
  // undecided root and still be slot-matched in its own right, and a pid the
  // scan has PLACED is not an open question; the window is the stronger fact.
  // Reporting a pid in two lists would put it in front of the user twice, in
  // two contradictory roles.
  //
  // What is subtracted is what will actually be remembered that way, not the
  // victim closure it was cut from. The two differ by the CLI's own branch,
  // and a spared row can sit in both closures at once; if it is not going to
  // be remembered with a window it has to stay undecided, or it is remembered
  // as nothing at all.
  //
  // The CLI's own branch is out of `undecided` altogether, and that is a
  // different statement from the sparing above. The branch is positively
  // identified - validated edges from this very process - and it is never the
  // host's, but its scan subprocess is slot-MATCHED (its command line names the
  // slot paths), so whenever the CLI itself is undecided (it claims a killed
  // host of unreadable age, say) the scan lands in the suspect closure. Kept
  // there it would be remembered as a HOST suspect, and a stranger that reuses
  // the scan's pid after it exits would have its child refuse a later round.
  // Only the uncertain non-slot ANCESTORS of the CLI stay undecided: sparing
  // them answers nothing about their other children.
  const remembered = new Set([...kill, ...protectedAncestors]);
  const undecidedClosure = [...suspects]
    .filter((pid) => !remembered.has(pid) && !cliBranch.has(pid))
    .sort((left, right) => left - right);
  return {
    kill,
    protectedAncestors,
    undecided: undecidedClosure,
    // The uncertain ancestors are spared from the REPORT. A protected row that
    // happens to claim a victim pid is not an open question about the host - it
    // is a process we have already decided never to kill - and reporting it
    // would fail every stop issued from a Traycer-hosted terminal. It stays in
    // `undecided`, because sparing it answers nothing about its children: the
    // shell above the CLI can exit between rounds, and its other children then
    // arrive as orphans claiming a pid that has to be remembered as undecided,
    // or they read as convergence.
    unattributed: undecidedClosure.filter((pid) => !spared.has(pid)),
  };
}

/**
 * What a round's scan says to do, split by what it can PROVE.
 *
 * `kill` is the ordinary answer.
 *
 * `protectedAncestors` is the CLI's own non-slot ancestors that this scan has
 * placed in the host's tree - a shell the host spawned to run the CLI. They are
 * never killed, and they are remembered with the same lifetime window as a
 * kill, because their children outside the CLI's branch are the host's and the
 * shell can exit between rounds.
 *
 * `undecided` is the rows that claim a remembered process as their parent but
 * cannot be tied to it - born after the victim was last seen alive, or carrying
 * an unreadable creation time - plus everything that hangs off those rows,
 * minus what is being remembered with a window (`kill` and
 * `protectedAncestors`) and minus the CLI's own descendant branch, which is
 * never the host's. They are neither killed (they may be strangers) nor ignored
 * (they may be the host's children).
 *
 * `unattributed` is the subset of `undecided` the loop REPORTS - it refuses to
 * claim a stop rather than pick silently - and it additionally leaves out the
 * CLI's uncertain ancestors, which are never killed and never a reason to
 * refuse. The loop's suspect memory is fed from `undecided`, not from the
 * report: a protected root's uncertainty is inherited by its children whether
 * or not the root itself is ever named, and it has to outlive the root.
 */
export interface WindowsHostKillSet {
  readonly kill: readonly number[];
  readonly protectedAncestors: readonly number[];
  readonly undecided: readonly number[];
  readonly unattributed: readonly number[];
}

/**
 * A pid this loop has placed in the host's tree - killed, or spared as one of
 * the CLI's own ancestors - and the interval in which that pid demonstrably
 * belonged to that process.
 *
 * `seenAliveAt` is the clock sampled once per round, in epoch microseconds,
 * BEFORE the scan that selects the round's victims runs. Before the scan, not
 * before the kill, and the difference is the whole soundness argument: the scan
 * observes the victim alive at some instant AFTER the sample, so the pid was
 * still the victim's at the sampled instant. Sampling before the kill proves
 * nothing of the sort - the victim can exit on its own between the scan and the
 * kill, its pid be reused, and the replacement fork a child, all before the
 * clock is read, and that child's birth then falls inside a window it has no
 * business being in.
 */
export interface WindowsKillVictim {
  readonly created: number;
  readonly seenAliveAt: number;
}

/**
 * What earlier rounds of the kill loop remember, and the only thing carrying
 * either kind of knowledge across a scan boundary.
 *
 * `victims` is what the loop has placed in the host's tree, by pid, one entry
 * per incarnation: every pid it killed, and every ancestor of the CLI it placed
 * and declined to kill (`WindowsHostKillSet.protectedAncestors`) - the name is
 * the kill's, the evidence is the same lifetime window either way. `suspects`
 * is what it could place neither in the slot nor out of it,
 * by pid, one creation time per incarnation it saw - the age is all a suspect
 * needs, because `classifyAgainstSuspect` has no upper bound to compare
 * against. Neither list is ever shortened: a newer holder of a pid is new
 * evidence beside the old, never a replacement for it.
 *
 * `protectedAncestors` is the CLI's own ancestors by identity, so that a
 * shell whose wrapper to the CLI has exited is still recognised as the process
 * the loop decided never to kill (see `WindowsHostKillSet.protectedAncestors`).
 *
 * One value rather than three parameters because the halves are never
 * meaningful apart: every round records into all of them from the same
 * snapshot, and every classification consults them together.
 */
export interface WindowsKillMemory {
  readonly victims: ReadonlyMap<number, readonly WindowsKillVictim[]>;
  readonly suspects: ReadonlyMap<number, readonly number[]>;
  // This CLI's own ancestors by identity - pid to the creation time of each
  // incarnation an earlier round saw as an ancestor. A later row with that pid
  // AND that creation time is the same process, and stays spared even when the
  // live edges that proved its ancestry are gone.
  readonly protectedAncestors: ReadonlyMap<number, readonly number[]>;
}

// How a row that claims a remembered pid as its parent is classified.
//
//   "seed"         - born inside the victim's proven lifetime; kill it.
//   "unattributed" - claims the pid but cannot be tied to it or ruled out of it.
//   "none"         - not a carry-over question at all.
type CarryOverClaim = "seed" | "unattributed" | "none";

// Whether this row was created BY a process an earlier round killed, or by one
// it could not place.
//
// The gate is the row's own validated edge, and it comes first because a
// validated edge is real lineage. The scan validates an edge only when the
// claimed parent is live and NOT younger than the row; a pid reused after its
// holder died always goes to a process younger than any child of the old
// holder, so a stranger wearing the parent's pid can never validate. What CAN
// change between rounds is the scan's ability to read an age: a live parent
// whose creation time was unreadable in one round zeroes its child's edge (and
// the child, claiming a remembered pid, is reported undecided), and a later
// round that reads the age validates the same edge. That later reading is new
// evidence and outranks the earlier suspicion, which is why nothing here keeps a
// row undecided by its own identity once its edge validates. Uncertainty about
// a child whose LIVE parent is itself undecided is preserved by the descendant
// closure in `computeWindowsHostKillSet`, not here; and once that parent has
// exited, by the suspect entry the loop recorded for it - for every member of
// the closure, the CLI's protected branch included, so a child that outlives a
// spared shell still finds its parent's pid remembered.
//
// The gate is NOT redundant with the rules below. The case it decides is a
// live, validated parent wearing a pid this loop killed earlier: an unrelated
// process that took the pid after the victim died and then forked. Its child is
// born after the victim's window and would read as undecided on the window
// alone; the scan has already tied it to a living parent, which is the better
// fact, so it is not a carry-over question.
//
// Every remembered incarnation of the claimed pid is consulted, and the
// STRONGEST verdict wins. A pid can have been a suspect in one round and a
// victim in a later one, or killed twice as two different processes, and each
// incarnation is evidence about the rows born during it: a row older than the
// newest incarnation is "none" against that one but may be inside an older
// window (seed) or after an older suspect's birth (unattributed). Taking the
// first answer would let the newest holder of a pid erase what the loop learned
// about the previous holder's children.
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

// A claim on a pid this loop killed, decided by a LIFETIME WINDOW.
//
// The question is lineage, and lineage is a claim about the past: which
// incarnation of this pid created this row. An earlier version of this code
// tried to answer it by inspecting the pid's CURRENT holder, which cannot work
// - a pid reused and vacated between two scans leaves no trace in the table, so
// a stranger forked by that intermediate holder arrives looking exactly like the
// victim's own child.
//
// The window does answer it, provided the upper bound is honest. Pid reuse is
// sequential: from `victim.created` until the victim died, that pid was the
// victim's and nobody else's. `seenAliveAt` is sampled before the scan that
// found the victim alive, so the pid was still the victim's at that instant, and
// a row claiming it that was born at or before then was created BY it.
//
// The order of the three answers is the order of what they can PROVE, and the
// lower bound comes first because it proves the most. A row OLDER than the
// victim cannot be the victim's child - a process cannot predate its own parent
// - so the claimed id is somebody else's, an id this row has worn since before
// the victim existed. That is a decided question, not an open one: reporting it
// would fail the stop over a long-lived stranger that any retry finds sitting in
// exactly the same place, which is a refusal nothing can clear.
//
// A row born after `seenAliveAt` is the genuinely open case. It may be the
// host's child, spawned in the moments before its parent died; it may belong to
// whoever holds that pid next. Nothing in the table distinguishes them, so it is
// reported as `unattributed` and the caller fails the stop rather than silently
// killing a stranger or silently sparing a host process.
//
// Both ends are `<=`. A child born in the same microsecond as its parent is
// ordinary; a child born in the same microsecond as the sample was observed
// alive by the scan that followed it.
function classifyAgainstVictim(
  created: number,
  victim: WindowsKillVictim,
): CarryOverClaim {
  // An unreadable age on either side leaves nothing to compare. This is checked
  // before the lower bound because 0 would pass it - a row of age 0 is older
  // than every real victim - and "we could not read an age" must not be allowed
  // to masquerade as the proof that clears a claim.
  if (victim.created === 0 || created === 0) return "unattributed";
  if (created < victim.created) return "none";
  if (created <= victim.seenAliveAt) return "seed";
  return "unattributed";
}

// A claim on a pid this loop could not place. Uncertainty is inherited: a
// process whose parent we cannot tie to the slot cannot itself be tied to the
// slot, and cannot be ruled out of it either.
//
// The one thing that CAN be ruled out is the same lower bound as above, for the
// same reason - a row older than the pid's remembered incarnation was created by
// an earlier holder, so this suspicion is not about it - and without it any
// long-lived process that happened to claim a recycled pid would poison every
// stop on the machine for as long as it ran.
//
// There is deliberately no upper bound here, and it is not a choice: a suspect's
// `seenAliveAt` cannot change any verdict. Inside it the row is provably the
// suspect's child, and a suspect's child inherits its suspicion; outside it the
// row may be the suspect's or a stranger's, which is undecided too. Both arms
// are `unattributed`, so the comparison is not worth the field it would need.
function classifyAgainstSuspect(
  created: number,
  suspectCreated: number,
): CarryOverClaim {
  if (suspectCreated === 0 || created === 0) return "unattributed";
  if (created < suspectCreated) return "none";
  return "unattributed";
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
  deps: WindowsControllerDeps,
): Promise<void> {
  await killHostProcessTree(label, runner ?? runCommand, deps);
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
    // The CLI prints the nonce with a trailing newline. VBScript `Trim`
    // strips SPACES only, and a VBScript RegExp `$` (no Multiline) does not
    // match before a trailing LF, so `Trim(...)` alone left a 37-char string
    // the pattern below rejected: every task-managed start ran `host start`
    // WITHOUT `--adoption-nonce`, the supervisor refused the still-valid
    // grant until it expired (~60 s), and install / restart / update all
    // reported failure while the host came up a minute later. Strip CR and
    // LF explicitly; `$(...)` does this for free on the POSIX launchers.
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
