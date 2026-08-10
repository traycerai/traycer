import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host stop` - asks the OS service manager to stop the
// host. Idempotent: a not-running host resolves cleanly.
//
// `cli-lock` coverage (Host Update Layer Redesign Tech Plan, "Lifecycle
// lock coverage"): a terminal stop must not enter another actor's
// apply/install/activation critical section and kill the process it
// just started - the stop itself executes inside the lock, short-held,
// and linearizes after a foreign holder releases.
export const hostStopCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const label = serviceLabelFor(ctx.runtime.environment);
  await withCliLock(
    {
      environment: ctx.runtime.environment,
      reason: "host-stop",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    () => createServiceController().stop(label),
  );
  return {
    data: { stopped: true, label: label.id },
    human: `requested stop for service '${label.id}'`,
    exitCode: 0,
  };
};
