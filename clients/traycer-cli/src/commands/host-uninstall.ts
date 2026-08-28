import {
  uninstallHost,
  type UninstallHostOptions,
  type UninstallHostResult,
} from "../installer";
import type { ILogger } from "../logger";
import type { CommandFn, CommandResult } from "../runner/runner";
import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceLabel,
  type ServiceState,
  type ServiceStatus,
  type StopServiceOptions,
  type UninstallServiceOptions,
} from "../service";
import {
  requireCliUpdateMutationCapability,
  withCliUpdateContender,
  type WithCliUpdateContenderOptions,
} from "../host/update-contender";
import {
  stopHostServiceWithAttempt,
  uninstallHostServiceWithAttempt,
} from "../host/update-mutation";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import { readHostPidMetadata } from "../host/pid-metadata";
import {
  getPublishedProcessIdentityVerdict,
  type PublishedProcessIdentityVerdict,
} from "../store/process-identity";

// `traycer host uninstall [--all]`:
//   default → remove the installed + staged host bytes and the install
//             record, and NOTHING else. The OS service stays registered, and
//             a host that is already running keeps running until it exits -
//             after which the surviving registration has no valid install to
//             launch. That end state is legal (it is how a
//             remove-then-reinstall is expressed) but it is not what
//             "optionally removes the OS service" suggests, so both the help
//             text and this command's own output name it explicitly.
//   --all   → deregister the OS service first, then cooperatively stop the
//             host, then remove the bytes. Runtime
//             state (pid metadata, log) is NEVER purged here: a `host start`
//             supervisor outlives its child and keeps writing, and nothing
//             available from this side proves it has stopped. Reported
//             liveness comes from process identity, and after `--all` only a
//             positive probe yields an answer at all.
// User data under ~/.traycer/ (chats, sqlite, downloaded models, credentials)
// is never removed - there is no destructive "purge" path.
export interface HostUninstallArgs {
  readonly all: boolean;
}

export interface RuntimePurgeStopController {
  stop(label: ServiceLabel, options: StopServiceOptions): Promise<void>;
}

export interface HostUninstallServiceController extends RuntimePurgeStopController {
  uninstall(options: UninstallServiceOptions): Promise<void>;
  status(label: ServiceLabel): Promise<ServiceStatus>;
}

/** The host process an environment last published, as pid.json recorded it. */
type PublishedHost = {
  readonly pid: number;
  readonly startIdentity: string | null;
};

export interface RunHostUninstallDeps {
  createServiceController(): HostUninstallServiceController;
  uninstallHost(options: UninstallHostOptions): Promise<UninstallHostResult>;
  /**
   * The host process this environment last published, read BEFORE the
   * teardown - because the teardown destroys it. On Windows the uninstall
   * removes pid metadata even when its `taskkill` calls failed, so a probe
   * that runs afterwards has nothing left to look at.
   */
  readPublishedHost(environment: Environment): Promise<PublishedHost | null>;
  /**
   * Did THAT process exit? Compares the OS process against the start identity
   * pid.json published, so a recycled pid reads as gone rather than alive.
   *
   * Deliberately NOT `findLiveIncumbentHost`. That helper answers a different
   * question - "may I spawn?" - and is documented as biased toward `null`: a
   * missing pid.json, an invalid URL, or an unreachable endpoint all return
   * `null` so the supervisor spawns rather than leaving a machine hostless.
   * Reading `null` as "the process exited" would license the purge for a host
   * that is merely wedged, or whose metadata the teardown just deleted - the
   * same unsound inference as trusting a resolved `stop()`, one layer down.
   */
  probeProcessExited(
    pid: number,
    startIdentity: string | null,
  ): Promise<PublishedProcessIdentityVerdict>;
}

/** What the post-stop probe established, kept distinct from "it threw". */
type LivenessObservation = "gone" | "live" | "unknown";

export interface RunHostUninstallContext {
  readonly environment: Environment;
  readonly logger: ILogger;
  progress(info: ProgressInfo): void;
}

interface StopServiceBeforeRuntimePurgeArgs {
  readonly environment: Environment;
  readonly label: ServiceLabel;
  readonly logger: ILogger;
}

export interface HostUninstallActuators {
  uninstall(
    controller: HostUninstallServiceController,
    options: UninstallServiceOptions,
  ): Promise<void>;
  stop(
    controller: RuntimePurgeStopController,
    label: ServiceLabel,
    options: StopServiceOptions,
  ): Promise<void>;
  readonly verifyMutationCapability: () => Promise<void>;
}

// Did the stop CALL resolve? Necessary for the runtime purge but not
// sufficient - the caller pairs this with process-identity, registration and
// successor checks, because on Linux and Windows every teardown call tolerates
// its own failure and resolving proves nothing about the process. Service deregistration and install removal
// remain best-effort either way.
export async function stopServiceBeforeRuntimePurge(
  args: StopServiceBeforeRuntimePurgeArgs,
  stop: () => Promise<void>,
): Promise<boolean> {
  try {
    await stop();
    return true;
  } catch (err) {
    args.logger.warn("Host uninstall service stop failed; preserving runtime", {
      environment: args.environment,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function buildHostUninstallCommand(args: HostUninstallArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host uninstall command started", {
      environment: ctx.runtime.environment,
      all: args.all,
    });
    return withCliUpdateContender(
      {
        environment: ctx.runtime.environment,
        reason: "host-uninstall",
        waitMs: 30_000,
        pollIntervalMs: 100,
        admission: "uninstall-maintenance",
      },
      (capability) =>
        runHostUninstallWithAttempt(
          args,
          {
            environment: ctx.runtime.environment,
            logger: ctx.runtime.logger,
            progress: ctx.progress,
          },
          {
            createServiceController,
            uninstallHost,
            readPublishedHost: async (environment) => {
              const metadata = await readHostPidMetadata(environment);
              if (metadata === null) return null;
              return {
                pid: metadata.pid,
                startIdentity: metadata.processStartIdentity,
              };
            },
            probeProcessExited: getPublishedProcessIdentityVerdict,
          },
          capability,
        ),
    );
  };
}

export async function runHostUninstall(
  args: HostUninstallArgs,
  ctx: RunHostUninstallContext,
  deps: RunHostUninstallDeps,
  actuators: HostUninstallActuators,
): Promise<CommandResult> {
  return runHostUninstallWithActuators(args, ctx, deps, actuators);
}

export async function runHostUninstallWithAttempt(
  args: HostUninstallArgs,
  ctx: RunHostUninstallContext,
  deps: RunHostUninstallDeps,
  capability: UpdateMutationCapability,
): Promise<CommandResult> {
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment: ctx.environment,
    // The maintenance lease creates the capability for the sudo CALLER's
    // canonical home while this process runs elevated. Revalidation must name
    // the same home, or every in-attempt verify resolves the elevated
    // process's own home and refuses with wrong-host-home.
    hostHomeDir: capability.hostHomeDir,
    reason: "host-uninstall",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "uninstall-maintenance",
  };
  const verifyMutationCapability = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  return runHostUninstallWithActuators(args, ctx, deps, {
    uninstall: (controller, options) =>
      uninstallHostServiceWithAttempt(
        capability,
        contenderOptions,
        controller,
        options,
      ),
    stop: (controller, label, options) =>
      stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        controller,
        label,
        options,
      ),
    verifyMutationCapability,
  });
}

async function runHostUninstallWithActuators(
  args: HostUninstallArgs,
  ctx: RunHostUninstallContext,
  deps: RunHostUninstallDeps,
  actuators: HostUninstallActuators,
): Promise<CommandResult> {
  let serviceUninstalled = false;
  let purgeChannelRuntime = false;
  let retainedAfterAll: ServiceStatus | null = null;
  let registrationClear = false;
  // Captured FIRST, before anything is torn down. The teardown destroys this
  // evidence: on Windows `uninstallService` removes pid metadata even when its
  // `taskkill` calls failed or timed out, so a probe that runs afterwards is
  // guaranteed to find nothing and would read a surviving host as gone.
  //
  // Only `--all` needs the pre-teardown capture; the default path tears
  // nothing down and reads at the boundary instead, so reading here too was
  // wasted work whose result was discarded - and on Windows it cost seconds
  // (a `tasklist` sweep plus an identity read) of extra window in which a
  // relaunch loop could produce a successor.
  const published = args.all
    ? await readPublishedHostBestEffort(deps, ctx)
    : null;
  let liveness: LivenessObservation = "unknown";
  // Observed BEFORE anything is removed, on the default path: it is the only
  // way this command can say what it is about to leave behind. `--all` reads
  // its registration AFTER acting instead (see below), since what matters
  // there is what the teardown actually left.
  const retainedService = args.all
    ? null
    : await readServiceStateBestEffort(deps, ctx);
  if (args.all) {
    ctx.logger.warn(
      "Host uninstall command will deregister service and stop the host",
      {
        environment: ctx.environment,
      },
    );
    ctx.progress({
      stage: "service-stop",
      message: `stopping service for ${ctx.environment} environment`,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    const controller = deps.createServiceController();
    const label = serviceLabelFor(ctx.environment);
    // Deregister BEFORE waiting for the process to exit. On macOS the
    // running job stays under launchd's `KeepAlive` supervision until
    // its registration is torn down (`uninstall` -> `launchctl
    // bootout`); stopping first and deregistering after leaves a
    // window where a non-clean SIGTERM exit gets treated as a
    // failed/crashed exit and launchd respawns the host before we
    // ever reach `uninstall`. Deregistering first removes that
    // supervision so no exit outcome can trigger a respawn.
    await actuators.uninstall(controller, { label });
    serviceUninstalled = true;
    ctx.logger.info("Host uninstall service deregistered", {
      environment: ctx.environment,
      label: label.id,
    });
    // Install removal stays best-effort, but runtime files are preserved
    // unless the process is confirmed GONE. A host that is still serving is
    // still writing its pid metadata and rotating its log.
    const stopArgs = {
      environment: ctx.environment,
      label,
      logger: ctx.logger,
    };
    const stopResolved = await stopServiceBeforeRuntimePurge(stopArgs, () =>
      actuators.stop(controller, label, { force: false }),
    );
    // The resolved `stop()` is necessary but NOT sufficient - see
    // `findLiveHost`. Both halves are required: a stop that threw means the
    // host was never asked/consented to die, and a probe that still finds one
    // means the kill did not land. Only "asked, and nothing answers" earns the
    // purge that deletes pid metadata and rotates the active log.
    liveness = await observeLiveness(deps, ctx, published);
    // Registration is verified too, for the same reason: on Linux the unit
    // file is removed even when `disable --now` timed out, and on Windows
    // `/Delete` tolerates failure. Ask the controller what is actually
    // registered now rather than inferring it from a resolved call.
    retainedAfterAll = await readServiceStateBestEffort(deps, ctx);
    // Re-read at the PURGE BOUNDARY, after every probe above has had its
    // chance to take time. `published` describes the child we captured; this
    // asks whether anything is publishing NOW - a supervisor relaunch loop can
    // produce a successor while these probes are running.
    // `readPublishedHostBestEffort` returns null both for "nothing published"
    // and for "the record was unreadable or malformed". The second is not
    // evidence of absence, so it must not leave the captured child's `gone`
    // standing - `observeLiveness` reports unknown for a null input, which is
    // exactly the right answer here too.
    const successorRead = await readPublishedHostReadOutcome(deps, ctx);
    const successor = successorRead.host;
    if (!successorRead.answered) {
      liveness = "unknown";
    } else if (successor !== null) {
      // Identity-probe B rather than inheriting A's verdict. A successor
      // record is not proof of life either - it can be stale - so it gets the
      // same treatment A got.
      liveness = await observeLiveness(deps, ctx, successor);
    }
    registrationClear = retainedAfterAll?.state === "not-installed";
    // THE RUNTIME PURGE IS WITHHELD UNCONDITIONALLY, and that is a deliberate
    // retreat from what this command used to do.
    //
    // The purge deletes pid metadata and rotates the ACTIVE log, so it is only
    // safe when nothing can still be writing them. Proving the captured child
    // is dead does not prove that: `host start`'s supervisor deliberately
    // outlives its child - it finalises the exit, writes terminal and crash
    // markers into host.log, and only then consumes the stop intent and exits.
    // On Windows `schtasks /End` does not even signal it (host-start.ts
    // documents that it survives as an orphan), and every readback available
    // here is too weak to close the gap: Linux `not-installed` only means the
    // manifest this command just deleted is absent, and Windows maps EVERY
    // `/Query` failure - timeout and access denial included - to
    // `not-installed`.
    //
    // The honest instrument would be a backend-owned completion contract
    // ("unit/task/job stopped, no restart pending"), which is a
    // `ServiceController` change across three platforms and is tracked
    // separately. Until it exists, keeping the runtime costs a stale pid.json
    // for a dead process and an unrotated log - both harmless, and both
    // already the outcome of every unconfirmed stop today. Purging under a
    // live writer costs diagnostics for the failure the operator is most
    // likely to be investigating.
    purgeChannelRuntime = false;
    ctx.logger.info("Host uninstall preserved runtime state", {
      environment: ctx.environment,
      stopResolved,
      liveness,
      registrationClear,
      successorPublished: successor !== null,
      reason: "supervisor-quiescence-unproven",
    });
  }
  // The boundary re-read, on BOTH paths now: `published` describes the child
  // captured at entry; this asks what is publishing at the moment the bytes go.
  ctx.progress({
    stage: "uninstall",
    message: "removing installed host",
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  });
  await actuators.verifyMutationCapability();
  const result = await deps.uninstallHost({
    environment: ctx.environment,
    purgeChannelRuntime,
    verifyMutationCapability: actuators.verifyMutationCapability,
  });
  if (!args.all) {
    // AFTER the removal, deliberately. The default path stops nothing, so a
    // still-registered service or a foreground supervisor can publish a
    // successor while the install and staged directories are being deleted -
    // and a read taken before that would report the machine clean while the
    // successor serves the install just removed.
    const boundary = await readPublishedHostReadOutcome(deps, ctx);
    liveness = boundary.answered
      ? await observeLiveness(deps, ctx, boundary.host)
      : "unknown";
  }
  ctx.logger.info("Host uninstall command completed", {
    environment: ctx.environment,
    serviceUninstalled,
    removedInstallDir: result.removedInstallDir,
    removedStagedDir: result.removedStagedDir,
    purgedRuntime: result.purgedRuntime,
    hadInstallRecord: result.removedRecord !== null,
    retainedServiceState:
      (args.all ? retainedAfterAll : retainedService)?.state ?? null,
  });
  // Both fields report only what was OBSERVED. Neither is derived from a
  // backend call having resolved: on Linux and Windows every teardown call
  // tolerates failure, so a resolved `uninstall()`/`stop()` is not evidence
  // that the unit is gone or the process exited (see `findLiveHost`).
  //
  // `--all` reads both back from the platform after acting; the default path
  // reports its single pre-removal probe. Either probe failing yields null,
  // never a negative fact about something this command did not observe.
  const observedService = args.all ? retainedAfterAll : retainedService;
  // TRI-STATE, and the asymmetry is the point. A positive registration is a
  // real observation - `launchctl print` naming a loaded label, a systemd unit
  // reported active. A NEGATIVE one is not: Windows maps every
  // `schtasks /Query` failure to `not-installed`, Linux re-reads the manifest
  // this command just deleted, and macOS's `launchctl print` probe tolerates
  // non-zero while an unloaded SMAppService record is invisible to it. So
  // `not-installed` earns `null` (unverified), never `false`.
  const registrationRetained: boolean | null =
    observedService === null
      ? null
      : observedService.state === "not-installed"
        ? null
        : true;
  // NO platform can verify this today. macOS looked like the exception, but
  // `inspectLaunchdOwnership` tolerates non-zero too (a timeout collapses to
  // "not-loaded") and an unloaded SMAppService record is invisible to it -
  // which is exactly the record `uninstallService` warns may respawn at next
  // login on macOS <= 25. Linux re-reads the manifest this command deleted;
  // Windows maps every `/Query` failure to `not-installed`.
  //
  // So the legacy field keeps its REQUEST semantics - the deregistration was
  // performed and returned - documented rather than silently reinterpreted.
  // Narrowing it to a verified fact would have made Desktop's
  // `deregisteredService` projection permanently false, trading an overclaim
  // for a different wrong answer. The observed truth is the additive
  // `serviceRegistrationRetained` beside it, and the human copy is keyed on
  // THAT, so the prose never claims what the readback contradicts.
  const serviceRegistrationRetained = registrationRetained;
  // Liveness comes from PROCESS IDENTITY on both paths, never from
  // `ServiceStatus.state`. That field is about REGISTRATION: `busy-check.ts`
  // keys liveness off pid metadata instead, and `externally-managed` (the
  // Desktop-owned macOS label) deliberately folds in no run state at all and
  // reports no pid. Reading `state === "running"` therefore answered "false"
  // for a Desktop-managed host that was still serving - after this command had
  // just removed its bytes.
  // After `--all`, only a POSITIVE identity-current probe supports an answer.
  // `gone` there rests on a boundary metadata read that returns null for four
  // different reasons - a pre-publication successor, Windows having deleted
  // the metadata during its own teardown, an EACCES, or malformed JSON - none
  // of which is death. On the default path nothing was torn down, so `gone`
  // still means what it says.
  const hostStillRunning = args.all
    ? liveness === "live"
      ? true
      : null
    : liveness === "unknown"
      ? null
      : liveness === "live";
  return {
    data: {
      removedRecord: result.removedRecord,
      removedInstallDir: result.removedInstallDir,
      removedStagedDir: result.removedStagedDir,
      // Request semantics, VETOED by a positive readback. Desktop's
      // `parseUninstallResult` projects this straight to
      // `deregisteredService`, whose contract is "actually accomplished", so a
      // readback that positively found the registration still there must not
      // be published as success. Unknown (`null`) keeps the request answer:
      // no platform can verify absence, and reporting failure for every
      // uninstall would be a different wrong answer. See the tri-state note on
      // `registrationRetained`.
      serviceUninstalled: serviceUninstalled && registrationRetained !== true,
      deregisterRequested: serviceUninstalled,
      purgedRuntime: result.purgedRuntime,
      // What the machine is left holding, so an automated caller does not
      // have to infer the default path's end state from the absence of
      // `serviceUninstalled`. Both are `null` when the platform probe could
      // not answer - see the tri-state note above.
      serviceRegistrationRetained,
      retainedServiceState: observedService?.state ?? null,
      hostStillRunning,
    },
    human: humanSummary({
      removedVersion: result.removedRecord?.version ?? null,
      // The READBACK, not the request. Saying "deregistered OS service" while
      // the same result reports `serviceRegistrationRetained: true` had the
      // prose and the payload contradicting each other in one breath, and an
      // unanswerable probe must not count as agreement either.
      deregisterRequested: serviceUninstalled,
      serviceRegistrationRetained,
      hostStillRunning,
    }),
    exitCode: 0,
  };
}

// Best-effort like the status probe, and for the same reason: this exists to
// DESCRIBE the end state, so an unreachable endpoint degrades to "unknown"
// rather than failing a removal that already happened.
async function readPublishedHostBestEffort(
  deps: RunHostUninstallDeps,
  ctx: RunHostUninstallContext,
): Promise<PublishedHost | null> {
  return (await readPublishedHostReadOutcome(deps, ctx)).host;
}

/**
 * Distinguishes "nothing is published" from "the read did not answer" -
 * `readHostPidMetadata` collapses both to null, and only the first is evidence.
 */
async function readPublishedHostReadOutcome(
  deps: RunHostUninstallDeps,
  ctx: RunHostUninstallContext,
): Promise<{
  readonly answered: boolean;
  readonly host: PublishedHost | null;
}> {
  try {
    return {
      answered: true,
      host: await deps.readPublishedHost(ctx.environment),
    };
  } catch (err) {
    ctx.logger.warn("Host uninstall could not read published host metadata", {
      environment: ctx.environment,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { answered: false, host: null };
  }
}

/**
 * Is the process this environment published still alive?
 *
 * Every arm defaults toward `"unknown"`, because `"gone"` is the only answer
 * that licenses deleting another process's runtime files. In particular
 * "nothing was published" is NOT death: a host that started moments ago and
 * has not written pid.json yet is indistinguishable from a machine with no
 * host, and it is actively writing the log this would rotate.
 *
 * `indeterminate` (the OS probe could not answer) stays unknown for the same
 * reason. Only a verdict that positively places the recorded process in the
 * past - `dead`, or `mismatch` meaning its pid now belongs to something else -
 * counts as gone.
 */
async function observeLiveness(
  deps: RunHostUninstallDeps,
  ctx: RunHostUninstallContext,
  published: PublishedHost | null,
): Promise<LivenessObservation> {
  if (published === null) return "unknown";
  // `readHostPidMetadata` accepts any JSON number, while the identity helper
  // answers `dead` for anything non-integral or <= 0. A record carrying
  // `pid: -5` would otherwise read as proof the host exited and license the
  // purge. A pid that cannot name a process is unknown, not death. Validated
  // HERE rather than in the reader, so the successor check at the purge
  // boundary still sees that something published.
  if (!Number.isInteger(published.pid) || published.pid <= 0) return "unknown";
  try {
    const verdict = await deps.probeProcessExited(
      published.pid,
      published.startIdentity,
    );
    if (verdict === "dead" || verdict === "mismatch") return "gone";
    if (verdict === "current") return "live";
    return "unknown";
  } catch (err) {
    ctx.logger.warn("Host uninstall could not probe the published process", {
      environment: ctx.environment,
      pid: published.pid,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return "unknown";
  }
}

// Never fails the uninstall: this read exists to DESCRIBE the end state, and
// a platform probe that cannot answer (launchctl missing, a systemd user
// manager that was never started) must not turn a working removal into an
// error. An unanswerable probe simply drops the extra disclosure.
async function readServiceStateBestEffort(
  deps: RunHostUninstallDeps,
  ctx: RunHostUninstallContext,
): Promise<ServiceStatus | null> {
  try {
    return await deps
      .createServiceController()
      .status(serviceLabelFor(ctx.environment));
  } catch (err) {
    ctx.logger.warn("Host uninstall could not read the OS service state", {
      environment: ctx.environment,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function humanSummary(args: {
  readonly removedVersion: string | null;
  /** The deregistration was requested at all (i.e. this was `--all`). */
  readonly deregisterRequested: boolean;
  readonly serviceRegistrationRetained: boolean | null;
  readonly hostStillRunning: boolean | null;
}): string {
  const parts: string[] = [];
  if (args.removedVersion === null) {
    parts.push("host was not installed");
  } else {
    parts.push(`removed host ${args.removedVersion}`);
  }
  if (args.deregisterRequested) {
    parts.push(
      args.serviceRegistrationRetained === true
        ? "requested OS service deregistration, but it is still registered"
        : "requested OS service deregistration (no platform can verify removal - run 'traycer host service status' to check)",
    );
  }
  // Keyed on the liveness evidence, not on the purge - the purge is now always
  // withheld, so using it would warn on every clean teardown. What an operator
  // needs to know is whether anything is still serving.
  if (args.deregisterRequested) {
    if (args.hostStillRunning === true) {
      parts.push("the host is STILL RUNNING - run 'traycer host stop --force'");
    } else if (args.hostStillRunning === null) {
      parts.push(
        "could not confirm the host stopped - run 'traycer host status', then 'traycer host stop --force' if it is still up",
      );
    } else {
      parts.push("the host stopped");
    }
    // Deliberately says what THIS command did, not what the machine now
    // holds. Windows' own teardown removes pid metadata unconditionally after
    // kills that tolerate their own failure (`platforms/windows.ts`), so a
    // blanket "runtime was kept" is false there - and correcting that belongs
    // to the backend quiescence work, not to this summary.
    parts.push(
      "this command did not remove pid/log runtime (that is only safe once the supervisor is confirmed stopped)",
    );
  }
  // Keyed on the READBACK, so a deregistration whose backend call merely
  // resolved cannot print "deregistered" and "still registered" in one line.
  if (args.serviceRegistrationRetained === true) {
    parts.push(
      args.hostStillRunning === true
        ? "the OS service is still registered and the running host keeps serving until it exits, after which it cannot be started again - run 'traycer host uninstall --all' to stop and deregister it, or 'traycer host install' to reinstall"
        : "the OS service is still registered and has no install left to launch - run 'traycer host service uninstall' to deregister it, or 'traycer host install' to reinstall",
    );
  } else if (args.hostStillRunning === true && !args.deregisterRequested) {
    // Only on the default path: the `--all` arm above already said this, and
    // saying it twice read as two separate problems.
    parts.push(
      "a host is still running and keeps serving until it exits - run 'traycer host stop --force' to end it",
    );
  }
  return parts.join("; ");
}
