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
import { findLiveIncumbentHost } from "../host/incumbent-check";

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
   * Is a host actually serving? The same instrument `withStopIntent`'s
   * `retireIntentIfHostSurvived` uses to answer "did the kill land?", and for
   * the same reason: a resolved `stop()` is NOT evidence that it did.
   *
   * Every Linux and Windows backend call on the teardown path passes
   * `tolerateNonZeroExit: true`, and `runCommand` resolves on ANY error under
   * that flag - a non-zero exit, an unavailable systemd user bus, or its own
   * 15s timeout. So `systemctl --user disable --now` can time out, the unit
   * file gets removed, `stop()` returns, and nothing that happened proves the
   * host exited. Asking the endpoint is the only honest answer.
   */
  findLiveHost(environment: Environment): Promise<unknown | null>;
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
            findLiveHost: findLiveIncumbentHost,
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
  // Asked on both paths. The default path never stops anything, so this is
  // simply "is a host still serving the bytes we are about to remove?" - the
  // fact its own summary needs, and one `ServiceStatus.state` cannot supply.
  let liveness: LivenessObservation = args.all
    ? "unknown"
    : await observeLiveHost(deps, ctx);
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
    liveness = await observeLiveHost(deps, ctx);
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
      serviceUninstalled,
      purgedRuntime: result.purgedRuntime,
      retainedServiceState: retainedService?.state ?? null,
      hostStillRunning,
    }),
    exitCode: 0,
  };
}

// Best-effort like the status probe, and for the same reason: this exists to
// DESCRIBE the end state, so an unreachable endpoint degrades to "unknown"
// rather than failing a removal that already happened.
async function observeLiveHost(
  deps: RunHostUninstallDeps,
  ctx: RunHostUninstallContext,
): Promise<LivenessObservation> {
  try {
    return (await deps.findLiveHost(ctx.environment)) === null
      ? "gone"
      : "live";
  } catch (err) {
    ctx.logger.warn("Host uninstall could not probe for a live host", {
      environment: ctx.environment,
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
  readonly serviceUninstalled: boolean;
  readonly purgedRuntime: boolean;
  readonly retainedServiceState: ServiceState | null;
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
  } else if (args.serviceUninstalled) {
    // `--all`'s stop is cooperative and best-effort: `stopServiceBeforeRuntimePurge`
    // returns false when the host denied the claim or outlived it, and the
    // removal proceeds anyway. Saying nothing here is how an operator walks
    // away from `--all` believing the host is down while it keeps serving.
    parts.push(
      "could not confirm the host stopped, so it may still be running and its pid/log runtime was kept - run 'traycer host status', then 'traycer host stop --force' if it is still up",
    );
  }
  // The default path's end state, spelled out. Leaving a registered
  // supervisor pointed at an install that no longer exists is the one
  // outcome of this command a user is most likely not to have intended, and
  // it is silent otherwise - nothing fails, and nothing else reports it until
  // the next start attempt.
  // Keyed on the LIVENESS probe, not on `ServiceStatus.state`: a
  // Desktop-managed macOS registration reports `externally-managed` with no
  // run state, so keying on the state read "not running" for a host that was
  // still serving the bytes just removed.
  if (args.hostStillRunning === true) {
    parts.push(
      "the OS service is still registered and the running host keeps serving until it exits, after which it cannot be started again - run 'traycer host uninstall --all' to stop and deregister it, or 'traycer host install' to reinstall",
    );
  } else if (
    args.retainedServiceState !== null &&
    args.retainedServiceState !== "not-installed"
  ) {
    parts.push(
      "the OS service is still registered and has no install left to launch - run 'traycer host service uninstall' to deregister it, or 'traycer host install' to reinstall",
    );
  }
  return parts.join("; ");
}
