import { killConflictingPortOwner } from "../host/free-port-kill";
import { attestInstallRuntime } from "../host/attested-install-runtime";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host free-port-and-restart --pid <pid> --port <port>` - the
// CLI-owned mapping for Doctor's Free-Port-and-Restart fix. Hidden from
// `--help` because it's a destructive, last-resort knob the renderer
// dispatches via NDJSON after confirming process identity with the user.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): the kill (if requested) and the restart both execute
// inside ONE lock acquisition, so this can never enter another actor's
// apply/install/activation critical section.
export interface HostFreePortAndRestartArgs {
  readonly pid: number | null;
  readonly port: number | null;
}

export function buildHostFreePortAndRestartCommand(
  args: HostFreePortAndRestartArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (args.pid !== null && args.port === null) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host free-port-and-restart: --pid requires --port so we can verify the PID actually owns the conflicting port",
        details: { pid: args.pid, port: null },
        exitCode: 1,
      });
    }
    const label = serviceLabelFor(ctx.runtime.environment);
    const { killed, killError, attestation } = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-free-port-and-restart",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        let killedInner = false;
        let killErrorInner: string | null = null;
        if (args.pid !== null && args.port !== null) {
          ctx.progress({
            stage: "kill-conflicting",
            message: `sending SIGTERM to pid ${args.pid}`,
            percent: null,
            bytes: null,
            totalBytes: null,
          });
          const result = await killConflictingPortOwner({
            pid: args.pid,
            port: args.port,
            commandName: "host free-port-and-restart",
          });
          killedInner = result.killed;
          killErrorInner = result.killError;
        }
        ctx.progress({
          stage: "service-restart",
          message: `requesting restart for service '${label.id}'`,
          percent: null,
          bytes: null,
          totalBytes: null,
        });
        await createServiceController().restart(label);
        return {
          killed: killedInner,
          killError: killErrorInner,
          attestation: await attestInstallRuntime(ctx.runtime.environment),
        };
      },
    );
    const human =
      killError !== null
        ? `restart requested; warning: failed to terminate pid ${args.pid ?? "?"}: ${killError}`
        : args.pid !== null
          ? `terminated pid ${args.pid}; restart requested for service '${label.id}'`
          : `restart requested for service '${label.id}'`;
    return {
      data: {
        port: args.port,
        pid: args.pid,
        processName: null,
        killed,
        killError,
        restartedLabel: label.id,
        installGeneration: attestation.installGeneration,
        runtimeVersion: attestation.runtimeVersion,
        runtimeWasNull: attestation.runtimeWasNull,
      },
      human,
      exitCode: 0,
    };
  };
}
