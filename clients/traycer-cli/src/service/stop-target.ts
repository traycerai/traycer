import { AsyncLocalStorage } from "node:async_hooks";
import type { RestartTargetHost } from "@traycer-clients/shared/host-lock/restart-target";
import { refuseUnlessRestartTarget } from "../host/restart-target-guard";
import type { Environment } from "../runner/environment";

/**
 * The host process a stop was confirmed for, held for the stop's duration so
 * every actuator edge inside it - each service-manager subprocess and each
 * signal - asks again, immediately before it acts, whether `pid.json` still
 * names that process (`refuseUnlessRestartTarget`). A check at the command's
 * admission alone is not enough: a host the supervisor admitted before the
 * command took its lock can publish after that check and before the signal,
 * and the unit-scoped signals reach it whatever was checked earlier.
 *
 * Scoped to the STOP half only. Once the confirmed host is down, the relaunch
 * publishes a host of its own, which this binding would read as a
 * replacement.
 */
interface StopTarget {
  readonly verb: string;
  readonly environment: Environment;
  readonly host: RestartTargetHost;
}

const stopTarget = new AsyncLocalStorage<StopTarget>();

export function withStopTarget<T>(
  verb: string,
  environment: Environment,
  host: RestartTargetHost | null,
  run: () => Promise<T>,
): Promise<T> {
  return host === null
    ? run()
    : stopTarget.run({ verb, environment, host }, run);
}

/**
 * Refuses `E_HOST_RESTART_TARGET_CHANGED` inside a `withStopTarget` scope
 * whose host is no longer the one published; does nothing outside one.
 */
export async function assertStopTarget(): Promise<void> {
  const target = stopTarget.getStore();
  if (target === undefined) return;
  await refuseUnlessRestartTarget(target.verb, target.environment, target.host);
}
