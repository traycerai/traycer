import { killConflictingPortOwner } from "../host/free-port-kill";
import { portRepairFailure } from "../host/free-port-outcome";
import {
  requireCliUpdateMutationCapability,
  withCliUpdateContender,
} from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import type { CommandFn, CommandResult } from "../runner/runner";

// Kill-only: free `port` held by `pid`. Does not restart.
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
      workUnits: null,
    });
    // ONE options value for acquisition and every in-segment revalidation: separate literals that must stay identical are how admission policies drift.
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-free-port",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "recovery-maintenance",
    };
    const result = await withCliUpdateContender(
      contenderOptions,
      (capability) =>
        killConflictingPortOwner({
          pid: args.pid,
          port: args.port,
          commandName: "host free-port",
          verifyMutationCapability: () =>
            requireCliUpdateMutationCapability(capability, contenderOptions),
        }),
    );
    const failure = portRepairFailure({
      result,
      pid: args.pid,
      port: args.port,
      commandName: "host free-port",
      // This command never restarts, so there is no skipped restart to
      // explain - the caller (`host restart` / `host ensure`) owns that step.
      restartWasSkipped: false,
    });
    if (failure !== null) throw failure;
    return {
      data: {
        port: args.port,
        pid: args.pid,
        killed: result.killed,
        // Retained at `null` on this path rather than dropped: the field is part of the payload Desktop has always read, and every non-null value is now a thrown error instead of a result.
        killError: result.killError,
        release: result.release,
        releaseDetail: result.releaseDetail,
        holderPid: result.holderPid,
      },
      // Render from what happened to the signal, not from the fact that we sent one.
      human: result.killed
        ? `sent SIGTERM to pid ${args.pid}; port ${args.port} released (${result.releaseDetail})`
        : `pid ${args.pid} could not be signalled (${result.killError}); port ${args.port} verified free anyway (${result.releaseDetail})`,
      exitCode: 0,
    };
  };
}
