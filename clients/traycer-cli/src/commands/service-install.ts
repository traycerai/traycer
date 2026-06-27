import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  resolveServiceCliInvocation,
  serviceLabelFor,
  serviceManifestPath,
  windowsTaskName,
} from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host service install [--no-linger]` - register the OS service
// for the current environment. `--no-linger` skips `loginctl
// enable-linger` on Linux.
export interface ServiceInstallArgs {
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
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
        ctx.progress({
          stage: "register",
          message: `registering service '${label.id}'`,
          percent: null,
          bytes: null,
          totalBytes: null,
        });
        await createServiceController().install({
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
          },
          human: `service '${label.id}' registered (environment=${label.environment})`,
          exitCode: 0,
        };
      },
    );
  };
}
