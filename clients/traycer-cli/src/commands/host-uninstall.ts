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
import { withCliLock } from "../store/cli-lock";
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
//             host, then remove the bytes. Environment runtime state (pid
//             metadata, log) is purged only once the host is CONFIRMED gone -
//             the stop call resolving is not that confirmation, because every
//             Linux/Windows teardown call tolerates its own failure. Both the
//             purge and the reported liveness come from an endpoint probe.
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

export interface RunHostUninstallDeps {
  createServiceController(): HostUninstallServiceController;
  uninstallHost(options: UninstallHostOptions): Promise<UninstallHostResult>;
  /**
   * The host process this environment last published, read BEFORE the
   * teardown - because the teardown destroys it. On Windows the uninstall
   * removes pid metadata even when its `taskkill` calls failed, so a probe
   * that runs afterwards has nothing left to look at.
   */
  readPublishedHost(environment: Environment): Promise<{
    readonly pid: number;
    readonly startIdentity: string | null;
  } | null>;
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
  readonly controller: RuntimePurgeStopController;
  readonly environment: Environment;
  readonly label: ServiceLabel;
  readonly logger: ILogger;
}

// Did the stop CALL resolve? Necessary for the runtime purge but not
// sufficient - the caller pairs this with an endpoint probe, because on Linux
// and Windows every teardown call tolerates its own failure and resolving
// proves nothing about the process. Service deregistration and install removal
// remain best-effort either way.
export async function stopServiceBeforeRuntimePurge(
  args: StopServiceBeforeRuntimePurgeArgs,
): Promise<boolean> {
  try {
    await args.controller.stop(args.label, { force: false });
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
    return withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-uninstall",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () =>
        runHostUninstall(
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
              return metadata === null
                ? null
                : {
                    pid: metadata.pid,
                    startIdentity: metadata.processStartIdentity,
                  };
            },
            probeProcessExited: getPublishedProcessIdentityVerdict,
          },
        ),
    );
  };
}

export async function runHostUninstall(
  args: HostUninstallArgs,
  ctx: RunHostUninstallContext,
  deps: RunHostUninstallDeps,
): Promise<CommandResult> {
  let serviceUninstalled = false;
  let purgeChannelRuntime = false;
  let retainedAfterAll: ServiceStatus | null = null;
  // Captured FIRST, before anything is torn down. The teardown destroys this
  // evidence: on Windows `uninstallService` removes pid metadata even when its
  // `taskkill` calls failed or timed out, so a probe that runs afterwards is
  // guaranteed to find nothing and would read a surviving host as gone.
  const published = await readPublishedHostBestEffort(deps, ctx);
  let liveness: LivenessObservation = await observeLiveness(
    deps,
    ctx,
    published,
  );
  // Observed BEFORE anything is removed, on the default path: it is the only
  // way this command can say what it is about to leave behind. `--all` reads
  // its registration AFTER acting instead (see below), since what matters
  // there is what the teardown actually left.
  const retainedService = args.all
    ? null
    : await readServiceStateBestEffort(deps, ctx);
  if (args.all) {
    ctx.logger.warn(
      "Host uninstall command will deregister service and purge runtime",
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
    await controller.uninstall({ label });
    serviceUninstalled = true;
    ctx.logger.info("Host uninstall service deregistered", {
      environment: ctx.environment,
      label: label.id,
    });
    // Install removal stays best-effort, but runtime files are preserved
    // unless the process is confirmed GONE. A host that is still serving is
    // still writing its pid metadata and rotating its log.
    const stopResolved = await stopServiceBeforeRuntimePurge({
      controller,
      environment: ctx.environment,
      label,
      logger: ctx.logger,
    });
    // The resolved `stop()` is necessary but NOT sufficient - see
    // `findLiveHost`. Both halves are required: a stop that threw means the
    // host was never asked/consented to die, and a probe that still finds one
    // means the kill did not land. Only "asked, and nothing answers" earns the
    // purge that deletes pid metadata and rotates the active log.
    liveness = await observeLiveness(deps, ctx, published);
    // BOTH halves, and `gone` here means POSITIVE death of the exact process
    // captured above - not "no incumbent found". The purge deletes pid
    // metadata and rotates the active log, so the only thing that licenses it
    // is evidence that nobody is writing them.
    purgeChannelRuntime = stopResolved && liveness === "gone";
    if (!purgeChannelRuntime) {
      ctx.logger.warn("Host uninstall withheld the runtime purge", {
        environment: ctx.environment,
        stopResolved,
        liveness,
      });
    }
    // Registration is verified too, for the same reason: on Linux the unit
    // file is removed even when `disable --now` timed out, and on Windows
    // `/Delete` tolerates failure. Ask the controller what is actually
    // registered now rather than inferring it from a resolved call.
    retainedAfterAll = await readServiceStateBestEffort(deps, ctx);
  }
  ctx.progress({
    stage: "uninstall",
    message: "removing installed host",
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  });
  const result = await deps.uninstallHost({
    environment: ctx.environment,
    purgeChannelRuntime,
  });
  ctx.logger.info("Host uninstall command completed", {
    environment: ctx.environment,
    serviceUninstalled,
    removedInstallDir: result.removedInstallDir,
    removedStagedDir: result.removedStagedDir,
    purgedRuntime: result.purgedRuntime,
    hadInstallRecord: result.removedRecord !== null,
    retainedServiceState: retainedService?.state ?? null,
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
  const serviceRegistrationRetained =
    observedService === null ? null : observedService.state !== "not-installed";
  // Liveness comes from the endpoint probe on BOTH paths, never from
  // `ServiceStatus.state`. That field is about REGISTRATION: `busy-check.ts`
  // keys liveness off pid metadata instead, and `externally-managed` (the
  // Desktop-owned macOS label) deliberately folds in no run state at all and
  // reports no pid. Reading `state === "running"` therefore answered "false"
  // for a Desktop-managed host that was still serving - after this command had
  // just removed its bytes.
  const hostStillRunning = liveness === "unknown" ? null : liveness === "live";
  return {
    data: {
      removedRecord: result.removedRecord,
      removedInstallDir: result.removedInstallDir,
      removedStagedDir: result.removedStagedDir,
      serviceUninstalled,
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
      // prose and the payload contradicting each other in one breath.
      serviceUninstalled:
        serviceUninstalled && serviceRegistrationRetained !== true,
      deregisterRequested: serviceUninstalled,
      purgedRuntime: result.purgedRuntime,
      serviceRegistrationRetained,
      hostStillRunning,
    }),
    exitCode: 0,
  };
}

// Best-effort like the status probe, and for the same reason: this exists to
// DESCRIBE the end state, so an unreachable endpoint degrades to "unknown"
// rather than failing a removal that already happened.
type PublishedHost = {
  readonly pid: number;
  readonly startIdentity: string | null;
};

async function readPublishedHostBestEffort(
  deps: RunHostUninstallDeps,
  ctx: RunHostUninstallContext,
): Promise<PublishedHost | null> {
  try {
    return await deps.readPublishedHost(ctx.environment);
  } catch (err) {
    ctx.logger.warn("Host uninstall could not read published host metadata", {
      environment: ctx.environment,
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
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
  /** The deregistration was requested AND the readback agrees it landed. */
  readonly serviceUninstalled: boolean;
  /** The deregistration was requested at all (i.e. this was `--all`). */
  readonly deregisterRequested: boolean;
  readonly purgedRuntime: boolean;
  readonly serviceRegistrationRetained: boolean | null;
  readonly hostStillRunning: boolean | null;
}): string {
  const parts: string[] = [];
  if (args.removedVersion === null) {
    parts.push("host was not installed");
  } else {
    parts.push(`removed host ${args.removedVersion}`);
  }
  if (args.serviceUninstalled) parts.push("deregistered OS service");
  if (args.purgedRuntime) {
    parts.push("confirmed the host stopped and cleared its runtime state");
  } else if (args.deregisterRequested) {
    // `--all`'s stop is cooperative and its backend calls tolerate their own
    // failures, so "the call returned" is not "the host exited". Saying
    // nothing here is how an operator walks away believing it is down.
    parts.push(
      "could not confirm the host stopped, so it may still be running and its pid/log runtime was kept - run 'traycer host status', then 'traycer host stop --force' if it is still up",
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
  } else if (args.hostStillRunning === true) {
    parts.push(
      "a host is still running and keeps serving until it exits - run 'traycer host stop --force' to end it",
    );
  }
  return parts.join("; ");
}
