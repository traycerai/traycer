import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { stopHostServiceWithAttempt } from "../host/update-mutation";

// `traycer host stop` - asks the OS service manager to stop the host.
// Idempotent: a not-running host resolves cleanly.
export interface HostStopArgs {
  readonly force: boolean;
}

export function buildHostStopCommand(args: HostStopArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const label = serviceLabelFor(ctx.runtime.environment);
    // ONE options value for acquisition and revalidation: two literals that
    // must stay identical are how admission policies drift.
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-stop",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "service-maintenance",
    };
    await withCliUpdateContender(contenderOptions, (capability) =>
      stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        createServiceController(),
        label,
        { force: args.force },
      ),
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
