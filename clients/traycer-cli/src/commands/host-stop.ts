import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host stop` - asks the OS service manager to stop the
// host. Idempotent: a not-running host resolves cleanly.
//
// `--force`: skip the cooperative shutdown claim and kill the host process
// (SIGTERM, then SIGKILL after the exit grace). The claim exists to protect
// in-flight work, and a busy host denies it indefinitely - any open plain
// terminal tab is enough - so without an explicit escape hatch "stop the
// host to free resources" has no supported path. Force is that consent:
// running sessions and in-flight agent work are killed.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): a terminal stop must not enter another actor's
// apply/install/activation critical section and kill the process it
// just started - the stop itself executes inside the lock, short-held,
// and linearizes after a foreign holder releases.
export interface HostStopArgs {
  readonly force: boolean;
}

export function buildHostStopCommand(args: HostStopArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const label = serviceLabelFor(ctx.runtime.environment);
    await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-stop",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () => createServiceController().stop(label, { force: args.force }),
    );
    return {
      data: { stopped: true, label: label.id, forced: args.force },
      human: args.force
        ? `force-stopped service '${label.id}'`
        : `requested stop for service '${label.id}'`,
      exitCode: 0,
    };
  };
}
