import { purgeHostStage } from "../installer/stage-reconcile";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliLock } from "../store/cli-lock";

// Desktop's download lane invokes this only after a successful registry
// eligibility probe establishes that a staged release was withdrawn. It is
// intentionally separate from normal reconcile, which may restore old
// crash-recovery asides.
export const hostPurgeStageCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  await withCliLock(
    {
      environment: ctx.runtime.environment,
      reason: "host-purge-stage",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    () => purgeHostStage(ctx.runtime.environment),
  );
  return {
    data: { purged: true },
    human: "purged staged host artifacts",
    exitCode: 0,
  };
};
