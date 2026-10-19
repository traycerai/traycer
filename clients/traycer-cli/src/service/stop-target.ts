import { AsyncLocalStorage } from "node:async_hooks";
import type { RestartTargetHost } from "@traycer-clients/shared/host-lock/restart-target";
import { refuseUnlessRestartTarget } from "../host/restart-target-guard";
import type { Environment } from "../runner/environment";

/**
 * The host process a stop was confirmed for, held across the whole command
 * that can kill it - a restart's stop AND its relaunch, an install's takeover
 * AND its install - so every actuator edge inside it, each service-manager
 * subprocess and each signal, asks again, as the last thing before it acts,
 * whether `pid.json` still names that process (`refuseUnlessRestartTarget`).
 * A check at the command's admission alone is not enough: a host the
 * supervisor admitted before the command took its lock can publish after that
 * check and before the signal, and the unit- and label-wide verbs (`systemctl
 * kill` / `restart`, `launchctl bootout` / `kickstart -k`) reach it whatever
 * was checked earlier. The relaunch is as destructive as the stop: a
 * CLI-owned macOS stop always asks for `kickstart -k`, a forced Linux one for
 * `systemctl restart`.
 *
 * The binding is a rule about timing, not proof of who published a host:
 * `pid.json` does not say which launch produced its host. Each launch call is
 * checked before it is issued, so a host published by then is not this
 * command's. The binding ends once the first call after a spawn edge
 * (`atServiceSpawnEdge`) has returned, since the command's own host may
 * publish during that call or after it. A launch call that throws keeps the
 * binding armed. The one such failure a command continues past is the macOS
 * bootstrap race's "already loaded", which launched nothing, so the recovery
 * bootout after it is still held. Every other failed launch - a recycle that
 * timed out and may still have launched among them - ends the command, or
 * reaches the unacknowledged-start retry, which runs only after a read that
 * nothing is running (`rearmStopTarget`).
 */
interface StopTarget {
  readonly verb: string;
  readonly environment: Environment;
  readonly host: RestartTargetHost;
  // The next actuator call is the one a spawn edge guards.
  spawnPending: boolean;
  // A spawn-edge call returned: the command's own host may now be published.
  launched: boolean;
  // How far the command had got against the confirmed host, for a refusal
  // that has to say what was already done.
  progress: StopTargetProgress;
}

/** In the order a stop advances; a later note never lowers it. */
export type StopTargetProgress =
  | "nothing"
  | "service-calls"
  | "signalled"
  | "stop-ran";

const PROGRESS_RANK: Record<StopTargetProgress, number> = {
  nothing: 0,
  "service-calls": 1,
  signalled: 2,
  "stop-ran": 3,
};

const PROGRESS_REPORT: Record<StopTargetProgress, string | null> = {
  nothing: null,
  "service-calls":
    "it had already issued service-manager calls for the confirmed host",
  signalled: "SIGTERM had already been sent to the confirmed host",
  "stop-ran": "its stop had already run against the confirmed host",
};

const stopTarget = new AsyncLocalStorage<StopTarget>();

export function withStopTarget<T>(
  verb: string,
  environment: Environment,
  host: RestartTargetHost | null,
  run: () => Promise<T>,
): Promise<T> {
  return host === null
    ? run()
    : stopTarget.run(
        {
          verb,
          environment,
          host,
          spawnPending: false,
          launched: false,
          progress: "nothing",
        },
        run,
      );
}

/**
 * Refuses `E_HOST_RESTART_TARGET_CHANGED` inside a `withStopTarget` scope
 * whose host is no longer the one published; does nothing outside one, or
 * once the scope's own launch has been issued.
 */
export async function assertStopTarget(): Promise<void> {
  const target = stopTarget.getStore();
  if (target === undefined || target.launched) return;
  await refuseUnlessRestartTarget(
    target.verb,
    target.environment,
    target.host,
    PROGRESS_REPORT[target.progress],
  );
}

/** Records how far the scope's command has got; no-op outside a scope. */
export function noteStopTargetProgress(progress: StopTargetProgress): void {
  const target = stopTarget.getStore();
  if (target === undefined) return;
  if (PROGRESS_RANK[progress] > PROGRESS_RANK[target.progress]) {
    target.progress = progress;
  }
}

/** A spawn edge was passed: the next actuator call is a launch. */
export function noteStopTargetSpawnEdge(): void {
  const target = stopTarget.getStore();
  if (target === undefined || target.launched) return;
  target.spawnPending = true;
}

/**
 * Runs one actuator call - already checked by the caller's
 * `verifyServiceMutationAuthority` - and ends the binding when that call was a
 * launch and returned.
 */
export async function runAtStopTargetEdge<T>(
  act: () => Promise<T>,
): Promise<T> {
  const target = stopTarget.getStore();
  if (target === undefined) return act();
  const launching = target.spawnPending;
  target.spawnPending = false;
  const result = await act();
  noteStopTargetProgress("service-calls");
  if (launching) target.launched = true;
  return result;
}

/**
 * Holds the scope to its confirmed host again, for a launch retried on a
 * positive read that nothing runs (`startRetryingUnacknowledged`): any host
 * published after that read is not one this command's earlier launch brought
 * up.
 */
export function rearmStopTarget(): void {
  const target = stopTarget.getStore();
  if (target === undefined) return;
  target.spawnPending = false;
  target.launched = false;
}
