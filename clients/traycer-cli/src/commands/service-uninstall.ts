import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { uninstallHostServiceWithAttempt } from "../host/update-mutation";
import { findForegroundHostRun } from "../host/foreground-host-run";
import {
  readServiceRegistrationOwnership,
  serviceTaskNotOwnedError,
} from "../service/registration-owner";

// `traycer host service uninstall` - deregister the OS service for the
// current environment. Idempotent: a not-installed service resolves
// cleanly. Does NOT remove the host install dir; that's
// `host uninstall --all`. A host started in a terminal keeps running.
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
    // This command asks for the service registration and nothing else, so
    // when that registration is another user's there is nothing of this
    // account's to remove, and "deregistered" would be false: it refuses
    // before anything - stop, sweep, launcher, task - is touched. (`host
    // uninstall` has work of its own and finishes it beside their task.)
    const ownership = await readServiceRegistrationOwnership(
      label,
      process.platform,
    );
    if (ownership.kind === "not-owned") {
      throw serviceTaskNotOwnedError(label, "delete", ownership.reason);
    }
    // Read under the lock, which keeps the answer true: a new host is spawned
    // only under this same lock. A host a person started in a terminal is not
    // the service's, so removing the service leaves it running, on every
    // platform and whoever asks (`UninstallServiceOptions.leaveForegroundRun`).
    const foregroundRun = await findForegroundHostRun(ctx.runtime.environment);
    ctx.runtime.logger.debug("Service uninstall label resolved", {
      environment: ctx.runtime.environment,
      label: label.id,
      leavesForegroundRun: foregroundRun !== null,
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
      { label, leaveForegroundRun: foregroundRun },
    );
    ctx.runtime.logger.info("Service uninstall command completed", {
      environment: ctx.runtime.environment,
      label: label.id,
      leftForegroundRun: foregroundRun !== null,
    });
    return {
      data: {
        label: label.id,
        environment: label.environment,
        leftRunning: foregroundRun === null ? null : "foreground",
      },
      human:
        foregroundRun === null
          ? `service '${label.id}' deregistered`
          : `service '${label.id}' deregistered; a host you started in a terminal is still running (supervisor pid ${String(foregroundRun.supervisorPid)}); it was left alone`,
      exitCode: 0,
    };
  });
};
