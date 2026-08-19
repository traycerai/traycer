import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  resolveServiceCliInvocation,
  serviceLabelFor,
  serviceManifestPath,
  windowsTaskName,
  type DesktopRegistrationTakeover,
} from "../service";
import { withCliLock } from "../store/cli-lock";
import { attestInstallRuntime } from "../host/attested-install-runtime";

// `traycer host service install [--no-linger] [--takeover]` - register the
// OS service for the current environment. `--no-linger` skips `loginctl
// enable-linger` on Linux. `--takeover` (macOS) moves host management from
// the Traycer Desktop app to the CLI: the Desktop-managed host is stopped
// cooperatively, its agent registration booted out, and the CLI-owned
// service registered in its place.
export interface ServiceInstallArgs {
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  readonly takeover: boolean;
}

export function buildServiceInstallCommand(
  args: ServiceInstallArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Service install command started", {
      environment: ctx.runtime.environment,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
    });
    return withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "service-install",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        const label = serviceLabelFor(ctx.runtime.environment);
        const cli = await resolveServiceCliInvocation({
          environment: ctx.runtime.environment,
          override: null,
          allowSelfInvocation: args.allowSelfInvocation,
        });
        ctx.runtime.logger.debug("Service install CLI invocation resolved", {
          environment: ctx.runtime.environment,
          label: label.id,
          argCount: cli.args.length,
        });
        const controller = createServiceController();
        let takeover: DesktopRegistrationTakeover | null = null;
        if (args.takeover) {
          ctx.progress({
            stage: "register",
            message: `taking over host management from Traycer Desktop`,
            percent: null,
            bytes: null,
            totalBytes: null,
            workUnits: null,
          });
          takeover = await controller.takeoverDesktopRegistration(label);
          ctx.runtime.logger.info("Service install takeover step completed", {
            environment: ctx.runtime.environment,
            label: label.id,
            outcome: takeover.kind,
          });
        }
        ctx.progress({
          stage: "register",
          message: `registering service '${label.id}'`,
          percent: null,
          bytes: null,
          totalBytes: null,
          workUnits: null,
        });
        await controller.install({
          label,
          cli,
          enableLinger: args.enableLinger,
        });
        const platform = process.platform;
        const manifestPath =
          platform === "win32"
            ? windowsTaskName(label)
            : serviceManifestPath(label);
        ctx.runtime.logger.info("Service install command completed", {
          environment: ctx.runtime.environment,
          label: label.id,
          platform,
          enableLinger: args.enableLinger,
        });
        return {
          data: {
            label: label.id,
            displayName: label.displayName,
            environment: label.environment,
            manifestPath,
            cli: { command: cli.command, args: cli.args },
            ...(takeover === null ? {} : { takeover }),
            ...(await attestInstallRuntime(ctx.runtime.environment)),
          },
          human:
            takeover !== null && takeover.kind === "took-over"
              ? `service '${label.id}' registered (environment=${label.environment}); host management taken over from Traycer Desktop (agent '${takeover.agentLabelId}' deregistered, host ${takeover.cooperativeStop === "stopped" ? "stopped cooperatively" : takeover.cooperativeStop === "no-host" ? "was not running" : "was unreachable and booted out"})`
              : `service '${label.id}' registered (environment=${label.environment})`,
          exitCode: 0,
        };
      },
    );
  };
}
