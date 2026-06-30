import { uninstallHost } from "../installer";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host uninstall [--all]`:
//   default → remove install dir + record only
//   --all   → also deregister the OS service + clear environment runtime state
// User data under ~/.traycer/ (chats, sqlite, downloaded models, credentials)
// is never removed - there is no destructive "purge" path.
export interface HostUninstallArgs {
  readonly all: boolean;
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
          // Best-effort stop before uninstall so any held file handles
          // release cleanly. Tolerate failures - the uninstall path
          // forces removal regardless.
          try {
            await controller.stop(label);
          } catch (err) {
            ctx.runtime.logger.warn(
              "Host uninstall service stop failed; continuing",
              {
                environment: ctx.runtime.environment,
                errorName: err instanceof Error ? err.name : "Error",
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            );
            // Service may not be running; proceed.
          }
          await controller.uninstall({ label });
          serviceUninstalled = true;
          ctx.runtime.logger.info("Host uninstall service deregistered", {
            environment: ctx.runtime.environment,
            label: label.id,
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
          // --all also clears environment runtime state (pid metadata,
          // log) - the host is gone, those are just stale files.
          purgeChannelRuntime: args.all,
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
