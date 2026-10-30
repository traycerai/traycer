import { platform as osPlatform } from "node:os";
import type { ILogger } from "../logger";
import type { CommandFn, CommandResult } from "../runner/runner";
import type { Environment } from "../runner/environment";
import { serviceLabelFor, type ServiceLabel } from "../service";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { refreshHostServiceDefinitionWithAttempt } from "../host/update-mutation";
import { createServiceDefinitionRefresher } from "../service/definition-refresh";
import type { ServiceDefinitionRefresh } from "../service/service-definition";

// `traycer host service refresh` - bring the registered OS service definition
// to the current launcher form WITHOUT starting, stopping or restarting
// anything (see `service/service-definition.ts`). Traycer Desktop runs it
// after a lifecycle mode change it writes itself; `traycer host lifecycle
// set` runs the same mutation in-process; and the doctor names it as the
// repair for a definition a non-Background mode cannot park. Idempotent: a
// current definition, or no registration at all, changes nothing.

export interface ServiceDefinitionRefreshOutcome {
  readonly label: ServiceLabel;
  readonly result: ServiceDefinitionRefresh;
}

/** The whole refresh, under the same admission as every service mutation. */
export async function refreshServiceDefinitionUnderContender(
  environment: Environment,
): Promise<ServiceDefinitionRefreshOutcome> {
  return refreshUnderContender(environment, 30_000);
}

/**
 * A supervisor its service manager started brings its own CLI job's
 * definition to the current form before anything else, so a job registered
 * by an older CLI (a launcher form, or a stop budget - launchd `ExitTimeOut`,
 * systemd `TimeoutStopSec` - below today's) does not wait for a person or a
 * re-registration. The same definition-only write as `host service refresh`:
 * nothing is started, stopped, loaded or unloaded.
 *
 * macOS and Linux only, and only the CLI's own label: Desktop's registration
 * ships in its bundle. Never waits for the update contender - a held one
 * means an update or another service mutation is running, which writes the
 * definition itself, and this start must not stall behind it - and never
 * throws: a failed refresh must not cost the host its start.
 */
export async function refreshServiceDefinitionAtSupervisorStart(
  environment: Environment,
  serviceLabel: string,
  logger: ILogger,
): Promise<void> {
  if (serviceLabel !== serviceLabelFor(environment).id) return;
  const platform = osPlatform();
  if (platform !== "darwin" && platform !== "linux") return;
  try {
    const outcome = await refreshUnderContender(environment, 0);
    if (outcome.result.kind === "refreshed") {
      logger.info("Host service definition refreshed at supervisor start", {
        environment,
        label: outcome.label.id,
        form: outcome.result.form,
        appliesAt: outcome.result.appliesAt,
      });
    }
  } catch (cause) {
    logger.warn(
      "Host service definition was not refreshed at supervisor start; the next start tries again",
      {
        environment,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
}

async function refreshUnderContender(
  environment: Environment,
  waitMs: number,
): Promise<ServiceDefinitionRefreshOutcome> {
  // ONE options value for acquisition and every in-attempt revalidation.
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "service-refresh",
    waitMs,
    pollIntervalMs: 100,
    admission: "service-maintenance",
  };
  return withCliUpdateContender(contenderOptions, async (capability) => {
    const label = serviceLabelFor(environment);
    const result = await refreshHostServiceDefinitionWithAttempt(
      capability,
      contenderOptions,
      createServiceDefinitionRefresher(null),
      label,
    );
    return { label, result };
  });
}

/** One line for the terminal, naming when a rewrite takes effect. */
export function describeServiceDefinitionRefresh(
  outcome: ServiceDefinitionRefreshOutcome,
): string {
  const service = `service '${outcome.label.id}'`;
  switch (outcome.result.kind) {
    case "not-registered":
      return `${service} is not registered; there is no definition to refresh`;
    case "current":
      return `${service} already runs the current launcher; nothing was changed`;
    case "refreshed":
      return outcome.result.appliesAt === "next-login"
        ? `${service} now runs the current launcher. Nothing was started or stopped. It applies at the next login, not to a respawn before then: launchd keeps the definition it loaded until the job is unloaded at logout`
        : `${service} now runs the current launcher. Nothing was started or stopped: the running host keeps running, and the new launcher applies from its next start`;
  }
}

export const serviceRefreshCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  ctx.runtime.logger.info("Service refresh command started", {
    environment: ctx.runtime.environment,
  });
  const outcome = await refreshServiceDefinitionUnderContender(
    ctx.runtime.environment,
  );
  ctx.runtime.logger.info("Service refresh command completed", {
    environment: ctx.runtime.environment,
    label: outcome.label.id,
    result: outcome.result.kind,
  });
  return {
    data: {
      label: outcome.label.id,
      environment: outcome.label.environment,
      result: outcome.result,
    },
    human: describeServiceDefinitionRefresh(outcome),
    exitCode: 0,
  };
};
