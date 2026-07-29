import { killConflictingPortOwner } from "../host/free-port-kill";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliLock } from "../store/cli-lock";

// `traycer host free-port --pid <pid> --port <port>` - a kill-only
// sibling of `host free-port-and-restart` (Host Update Layer Redesign
// Tech Plan, "Lifecycle lock coverage"): Doctor's port-conflict repair
// uses this when the supervisor is already going to be restarted through
// a separate `host restart`/`host ensure` step, so a second unconditional
// restart here would be redundant. Hidden from `--help` for the same
// reason as `free-port-and-restart` - a destructive, last-resort knob
// the renderer dispatches after confirming process identity with the
// user.
//
// `cli-lock` coverage: the kill executes inside a single lock
// acquisition, so this can never enter another actor's
// apply/install/activation critical section.
export interface HostFreePortArgs {
  readonly pid: number;
  readonly port: number;
}

export function buildHostFreePortCommand(args: HostFreePortArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.progress({
      stage: "kill-conflicting",
      message: `sending SIGTERM to pid ${args.pid}`,
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    const { killed, killError } = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-free-port",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () =>
        killConflictingPortOwner({
          pid: args.pid,
          port: args.port,
          commandName: "host free-port",
        }),
    );
    const human =
      killError !== null
        ? `failed to terminate pid ${args.pid}: ${killError}`
        : `terminated pid ${args.pid} (port ${args.port} freed)`;
    return {
      data: {
        port: args.port,
        pid: args.pid,
        killed,
        killError,
      },
      human,
      exitCode: 0,
    };
  };
}
