import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { uninstallHostServiceWithAttempt } from "../host/update-mutation";

// `traycer host service uninstall` - deregister the OS service for the
// current environment. Idempotent: a not-installed service resolves
// cleanly. Does NOT remove the host install dir; that's
// `host uninstall --all`.
export const serviceUninstallCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  ctx.runtime.logger.info("Service uninstall command started", {
    environment: ctx.runtime.environment,
  });
  // ONE options value for acquisition and revalidation: two literals that
  // must stay identical are how admission policies drift.
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment: ctx.runtime.environment,
    reason: "service-uninstall",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "service-maintenance",
  };
  return withCliUpdateContender(contenderOptions, async (capability) => {
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
      workUnits: null,
    });
    await uninstallHostServiceWithAttempt(
      capability,
      contenderOptions,
      createServiceController(),
      { label },
    );
    ctx.runtime.logger.info("Service uninstall command completed", {
      environment: ctx.runtime.environment,
      label: label.id,
    });
    return {
      data: { label: label.id, environment: label.environment },
      human: `service '${label.id}' deregistered`,
      exitCode: 0,
    };
  });
};
