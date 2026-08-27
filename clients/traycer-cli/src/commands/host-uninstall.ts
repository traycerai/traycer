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
//             host, then remove the bytes; environment runtime state (pid
//             metadata, log) is purged only once the stop is confirmed.
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
}

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

// Runtime state belongs to the live host process, so deleting pid metadata or
// rotating its active log is only safe after the service controller confirms
// the process exited. Service deregistration/install removal remain
// best-effort even when this confirmation fails.
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
  // Observed BEFORE anything is removed, and only on the default path: it is
  // the only way this command can say what it is about to leave behind. On
  // `--all` the end state is unconditional (nothing registered, nothing
  // running) so there is nothing to report and no reason to pay for the
  // platform probe.
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
    // unless stop confirms the process is gone. A failed stop can leave
    // the host actively writing its pid metadata and log.
    purgeChannelRuntime = await stopServiceBeforeRuntimePurge({
      controller,
      environment: ctx.environment,
      label,
      logger: ctx.logger,
    });
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
  // Tri-state, deliberately, and the two fields do NOT share a rule.
  //
  // Registration is observed on both paths: `--all` deregisters and
  // `controller.uninstall` returned, so nothing is retained; the default path
  // reports what the probe saw, or null when it threw.
  //
  // Liveness is not. `--all` performs no probe, and its stop is cooperative
  // and best-effort - `stopServiceBeforeRuntimePurge` returns false when the
  // host denied or outlived the claim, and the removal proceeds anyway. Only
  // a CONFIRMED stop (which is exactly what gates the runtime purge) proves
  // the host is down; otherwise it may still be serving. Reporting `false`
  // there would have the machine envelope contradict this command's own human
  // summary, which already says the host may still be up.
  const serviceRegistrationRetained =
    args.all || retainedService !== null
      ? retainedService !== null && retainedService.state !== "not-installed"
      : null;
  const hostStillRunning = args.all
    ? purgeChannelRuntime
      ? false
      : null
    : retainedService === null
      ? null
      : retainedService.state === "running";
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
      retainedServiceState: retainedService?.state ?? null,
      hostStillRunning,
    },
    human: humanSummary({
      removedVersion: result.removedRecord?.version ?? null,
      serviceUninstalled,
      purgedRuntime: result.purgedRuntime,
      retainedServiceState: retainedService?.state ?? null,
    }),
    exitCode: 0,
  };
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
}): string {
  const parts: string[] = [];
  if (args.removedVersion === null) {
    parts.push("host was not installed");
  } else {
    parts.push(`removed host ${args.removedVersion}`);
  }
  if (args.serviceUninstalled) parts.push("deregistered OS service");
  if (args.purgedRuntime) {
    parts.push("cleared environment runtime state");
  } else if (args.serviceUninstalled) {
    // `--all`'s stop is cooperative and best-effort: `stopServiceBeforeRuntimePurge`
    // returns false when the host denied the claim or outlived it, and the
    // removal proceeds anyway. Saying nothing here is how an operator walks
    // away from `--all` believing the host is down while it keeps serving.
    parts.push(
      "the host did not confirm shutdown, so it may still be running and its pid/log runtime was kept - run 'traycer host stop --force' if it is still up",
    );
  }
  // The default path's end state, spelled out. Leaving a registered
  // supervisor pointed at an install that no longer exists is the one
  // outcome of this command a user is most likely not to have intended, and
  // it is silent otherwise - nothing fails, and nothing else reports it until
  // the next start attempt.
  if (args.retainedServiceState === "running") {
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
