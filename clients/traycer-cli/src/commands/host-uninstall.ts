import { uninstallHost } from "../installer";
import type { ILogger } from "../logger";
import type { CommandFn, CommandResult } from "../runner/runner";
import type { Environment } from "../runner/environment";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceLabel,
} from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host uninstall [--all]`:
//   default → remove install dir + record only
//   --all   → also deregister the OS service + clear environment runtime state
// User data under ~/.traycer/ (chats, sqlite, downloaded models, credentials)
// is never removed - there is no destructive "purge" path.
export interface HostUninstallArgs {
  readonly all: boolean;
}

export interface RuntimePurgeStopController {
  stop(label: ServiceLabel): Promise<void>;
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
    await args.controller.stop(args.label);
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
      async () => {
        let serviceUninstalled = false;
        let purgeChannelRuntime = false;
        if (args.all) {
          ctx.runtime.logger.warn(
            "Host uninstall command will deregister service and purge runtime",
            {
              environment: ctx.runtime.environment,
            },
          );
          ctx.progress({
            stage: "service-stop",
            message: `stopping service for ${ctx.runtime.environment} environment`,
            percent: null,
            bytes: null,
            totalBytes: null,
          });
          const controller = createServiceController();
          const label = serviceLabelFor(ctx.runtime.environment);
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
          ctx.runtime.logger.info("Host uninstall service deregistered", {
            environment: ctx.runtime.environment,
            label: label.id,
          });
          // Install removal stays best-effort, but runtime files are preserved
          // unless stop confirms the process is gone. A failed stop can leave
          // the host actively writing its pid metadata and log.
          purgeChannelRuntime = await stopServiceBeforeRuntimePurge({
            controller,
            environment: ctx.runtime.environment,
            label,
            logger: ctx.runtime.logger,
          });
        }
        ctx.progress({
          stage: "uninstall",
          message: "removing installed host",
          percent: null,
          bytes: null,
          totalBytes: null,
        });
        const result = await uninstallHost({
          environment: ctx.runtime.environment,
          purgeChannelRuntime,
        });
        ctx.runtime.logger.info("Host uninstall command completed", {
          environment: ctx.runtime.environment,
          serviceUninstalled,
          removedInstallDir: result.removedInstallDir,
          purgedRuntime: result.purgedRuntime,
          hadInstallRecord: result.removedRecord !== null,
        });
        return {
          data: {
            removedRecord: result.removedRecord,
            removedInstallDir: result.removedInstallDir,
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
      },
    );
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
