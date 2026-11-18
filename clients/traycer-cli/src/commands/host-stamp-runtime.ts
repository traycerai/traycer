import { stampRuntime, type StampRuntimeOutcome } from "../host/stamp-runtime";
import {
  requireCliUpdateMutationCapability,
  withCliUpdateContender,
} from "../host/update-contender";
import { resolveAttemptAdoptionFromNonce } from "../host/update-adoption";
import { hostHomeDir } from "../store/paths";
import type { CommandFn, CommandResult } from "../runner/runner";

// `traycer host stamp-runtime` (hidden, internal) - the desktop
// controller's sole caller of `stampRuntime` (Host Update Layer
// Redesign Tech Plan, "Unknown runtime identity" - one-time backfill).
// Invoked ONLY immediately after an activation cycle the controller
// itself drove observes readiness of the fresh process - see
// `host/stamp-runtime.ts` for the full CAS contract.
export interface HostStampRuntimeArgs {
  readonly expectedInstallGeneration: string;
  readonly observedPid: number;
  readonly observedStartedAt: string;
  readonly observedRuntimeVersion: string;
  /** See `HostApplyArgs.attemptAdoption`. `null` for an ordinary invocation. */
  readonly attemptAdoption: string | null;
}

export function buildHostStampRuntimeCommand(
  args: HostStampRuntimeArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host stamp-runtime command started", {
      environment: ctx.runtime.environment,
      observedPid: args.observedPid,
    });
    const adoption = await resolveAttemptAdoptionFromNonce(
      hostHomeDir(ctx.runtime.environment),
      args.attemptAdoption,
      Date.now(),
    );
    const outcome = await withCliUpdateContender(
      {
        environment: ctx.runtime.environment,
        reason: "host-stamp-runtime",
        waitMs: 30_000,
        pollIntervalMs: 100,
        admission: "runtime-repair-maintenance",
        adoption,
      },
      (capability) =>
        stampRuntime({
          environment: ctx.runtime.environment,
          expectedInstallGeneration: args.expectedInstallGeneration,
          observedPid: args.observedPid,
          observedStartedAt: args.observedStartedAt,
          observedRuntimeVersion: args.observedRuntimeVersion,
          verifyMutationCapability: () =>
            requireCliUpdateMutationCapability(capability, {
              environment: ctx.runtime.environment,
              reason: "host-stamp-runtime",
              waitMs: 30_000,
              pollIntervalMs: 100,
              admission: "runtime-repair-maintenance",
              adoption,
            }),
        }),
    );
    ctx.runtime.logger.info("Host stamp-runtime command completed", {
      environment: ctx.runtime.environment,
      outcome: outcome.outcome,
    });
    return {
      data: outcome,
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

function humanSummary(outcome: StampRuntimeOutcome): string {
  if (outcome.outcome === "stamped") {
    return `stamped runtimeVersion=${outcome.runtimeVersion}`;
  }
  return `superseded: ${outcome.reason}`;
}
