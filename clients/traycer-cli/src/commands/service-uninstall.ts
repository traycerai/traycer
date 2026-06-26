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
  ctx.runtime.logger.info("Service uninstall command started", {
    environment: ctx.runtime.environment,
  });
  return withCliLock(
    {
      environment: ctx.runtime.environment,
      reason: "service-uninstall",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      const label = serviceLabelFor(ctx.runtime.environment);
      ctx.runtime.logger.debug("Service uninstall label resolved", {
        environment: ctx.runtime.environment,
        label: label.id,
      });
      ctx.progress({
        stage: "deregister",
        message: `deregistering service '${label.id}'`,
        percent: null,
        bytes: null,
        totalBytes: null,
      });
      await createServiceController().uninstall({ label });
      ctx.runtime.logger.info("Service uninstall command completed", {
        environment: ctx.runtime.environment,
        label: label.id,
      });
      return {
        data: { label: label.id, environment: label.environment },
        human: `service '${label.id}' deregistered`,
        exitCode: 0,
      };
    },
  );
};
