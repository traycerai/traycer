import { purgeHostStage } from "../installer/stage-reconcile";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliLock } from "../store/cli-lock";

// Desktop's download lane invokes this only after a successful registry
// eligibility probe establishes that a staged release was withdrawn. It is
// intentionally separate from normal reconcile, which may restore old
// crash-recovery asides.
export function buildHostPurgeStageCommand(args: {
  readonly expectedStageFingerprint: string | null;
}): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (args.expectedStageFingerprint === null) {
      throw new Error(
        "host purge-stage requires an expected stage fingerprint",
      );
    }
    const result = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-purge-stage",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () =>
        purgeHostStage(ctx.runtime.environment, args.expectedStageFingerprint),
    );
    return result.outcome === "purged"
      ? {
          data: result,
          human: "purged staged host artifacts",
          exitCode: 0,
        }
      : {
          data: result,
          human: "staged host changed before it could be purged",
          exitCode: 0,
        };
  };
}
