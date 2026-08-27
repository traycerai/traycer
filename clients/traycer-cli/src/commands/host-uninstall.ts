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

// `traycer host uninstall [--all]`:
//   default → remove install dir + record only
//   --all   → also deregister the OS service + clear environment runtime state
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

// Runtime state belongs to the live host process, so deleting pid metadata or
// rotating its active log is only safe after the service controller confirms
// the process exited. Service deregistration/install removal remain
// best-effort even when this confirmation fails.
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
    await actuators.uninstall(controller, { label });
    serviceUninstalled = true;
    ctx.logger.info("Host uninstall service deregistered", {
      environment: ctx.environment,
      label: label.id,
    });
    // Install removal stays best-effort, but runtime files are preserved
    // unless stop confirms the process is gone. A failed stop can leave
    // the host actively writing its pid metadata and log.
    const stopArgs = {
      environment: ctx.environment,
      label,
      logger: ctx.logger,
    };
    purgeChannelRuntime = await stopServiceBeforeRuntimePurge(stopArgs, () =>
      actuators.stop(controller, label, { force: false }),
    );
  }
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
  ctx.logger.info("Host uninstall command completed", {
    environment: ctx.environment,
    serviceUninstalled,
    removedInstallDir: result.removedInstallDir,
    removedStagedDir: result.removedStagedDir,
    purgedRuntime: result.purgedRuntime,
    hadInstallRecord: result.removedRecord !== null,
  });
  return {
    data: {
      removedRecord: result.removedRecord,
      removedInstallDir: result.removedInstallDir,
      removedStagedDir: result.removedStagedDir,
      serviceUninstalled,
      purgedRuntime: result.purgedRuntime,
    },
    human: humanSummary({
      removedVersion: result.removedRecord?.version ?? null,
      serviceUninstalled,
      purgedRuntime: result.purgedRuntime,
    }),
    exitCode: 0,
  };
}

function humanSummary(args: {
  readonly removedVersion: string | null;
  readonly serviceUninstalled: boolean;
  readonly purgedRuntime: boolean;
}): string {
  const parts: string[] = [];
  if (args.removedVersion === null) {
    parts.push("host was not installed");
  } else {
    parts.push(`removed host ${args.removedVersion}`);
  }
  if (args.serviceUninstalled) parts.push("deregistered OS service");
  if (args.purgedRuntime) parts.push("cleared environment runtime state");
  return parts.join("; ");
}
