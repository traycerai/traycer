import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceLabelFor,
} from "../service";
import { withCliLock } from "../store/cli-lock";

// `traycer host service uninstall` - deregister the OS service for the
// current environment. Idempotent: a not-installed service resolves
// cleanly. Does NOT remove the host install dir; that's
// `host uninstall --all`.
export const serviceUninstallCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  return withCliLock(
    {
      environment: ctx.runtime.environment,
      reason: "service-uninstall",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      const label = serviceLabelFor(ctx.runtime.environment);
      ctx.progress({
        stage: "deregister",
        message: `deregistering service '${label.id}'`,
        percent: null,
        bytes: null,
        totalBytes: null,
      });
      await createServiceController().uninstall({ label });
      return {
        data: { label: label.id, environment: label.environment },
        human: `service '${label.id}' deregistered`,
        exitCode: 0,
      };
    },
  );
};
