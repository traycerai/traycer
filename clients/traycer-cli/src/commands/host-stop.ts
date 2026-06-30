import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";

// `traycer host stop` - asks the OS service manager to stop the
// host. Idempotent: a not-running host resolves cleanly.
export const hostStopCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const label = serviceLabelFor(ctx.runtime.environment);
  await createServiceController().stop(label);
  return {
    data: { stopped: true, label: label.id },
    human: `requested stop for service '${label.id}'`,
    exitCode: 0,
  };
};
