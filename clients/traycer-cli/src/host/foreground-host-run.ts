import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";
import { findLiveIncumbentHost } from "./incumbent-check";
import type { HostStartOrigin } from "./lifecycle-origin";
import { readLiveSupervisorRun } from "./live-supervisor-run";

/** A live host whose supervisor is not the service's. */
export interface ForegroundHostRun {
  readonly supervisorPid: number;
  readonly hostPid: number;
}

/**
 * The running host, when it is a `foreground` run: `traycer host start` in a
 * terminal, which no service manager started and so none can stop.
 *
 * Both halves are positive evidence, never a guess: a host answering its
 * recorded endpoint as the process `pid.json` names (`findLiveIncumbentHost`),
 * and a live supervisor admitted `foreground` (`readLiveSupervisorRun`: both
 * supervisor records naming one pid, and that pid the recorded process
 * instance). A record a killed supervisor left behind, a pid the OS reused,
 * or an identity that cannot be compared all read as "not a foreground run",
 * so a caller never refuses on a stale file.
 */
export async function findForegroundHostRun(
  environment: Environment,
): Promise<ForegroundHostRun | null> {
  const run = await readLiveSupervisorRun(environment);
  if (run === null || run.admission !== "foreground") return null;
  const host = await findLiveIncumbentHost(environment);
  if (host === null) return null;
  return { supervisorPid: run.supervisorPid, hostPid: host.pid };
}

/** The commands that refuse to act on a foreground run. */
export type ForegroundRunRefusingVerb =
  | "host stop"
  | "host restart"
  | "host free-port-and-restart"
  | "host apply"
  | "host ensure"
  | "host install"
  | "host service install"
  | "host service start"
  | "host uninstall";

/**
 * The one refusal every service-lifecycle command gives over a foreground
 * run: `E_HOST_NOT_SERVICE_RUN`, naming both pids.
 */
export function foregroundRunRefusal(
  verb: ForegroundRunRefusingVerb,
  run: ForegroundHostRun,
  origin: HostStartOrigin,
): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_NOT_SERVICE_RUN,
    message: `${verb}: the running host was started in a terminal (supervisor pid ${String(run.supervisorPid)}) and is not run by the service; ${foregroundRunRemedy(verb, origin)}`,
    details: { supervisorPid: run.supervisorPid, hostPid: run.hostPid },
    exitCode: 1,
  });
}

/**
 * What the refused request can do instead. `--force` is offered only where it
 * reaches that host - a terminal's `host stop --force` - never to the desktop,
 * whose requests are refused `--force` included: Linked governs the
 * service-run host only. A registration and a removal name their own next
 * step: each can go ahead once that host has stopped.
 */
function foregroundRunRemedy(
  verb: ForegroundRunRefusingVerb,
  origin: HostStartOrigin,
): string {
  if (verb === "host stop" && origin !== "desktop") {
    return "stop it there with Ctrl-C, or pass --force";
  }
  if (verb === "host service install") {
    return "stop it there with Ctrl-C, then register the service";
  }
  if (verb === "host uninstall") {
    return "stop it there with Ctrl-C, then remove Traycer";
  }
  return "stop it there with Ctrl-C";
}

/**
 * Refuse before touching anything when the running host is a foreground run.
 * Called FIRST inside each command's lock, ahead of any busy probe, stop
 * intent, stop, relaunch or port-owner kill, so a refused request leaves the
 * host, its records and every intent file exactly as they were. The lock
 * keeps the answer true for the rest of the section: a new host is spawned
 * only under that same update-attempt lock.
 */
export async function refuseForegroundHostRun(
  verb: ForegroundRunRefusingVerb,
  environment: Environment,
  origin: HostStartOrigin,
): Promise<void> {
  const run = await findForegroundHostRun(environment);
  if (run !== null) throw foregroundRunRefusal(verb, run, origin);
}

/**
 * The desktop leaves a host that a person started in a terminal untouched;
 * the lifecycle mode governs the service run only.
 *
 * `refuseForegroundHostRun` for a `desktop`-origin request, and nothing for
 * any other: a person's own command in a terminal acts on their own host as
 * it always has. Each caller places it at the point where it has committed to
 * disturbing the running host - past its no-op decisions, and before its busy
 * probe, stop intent, stop, kill, staging download, swap or takeover - so a
 * refused request changes nothing, and the next request after that host has
 * exited finishes the work.
 */
export async function refuseDesktopDisruptionOfForegroundRun(
  verb: ForegroundRunRefusingVerb,
  environment: Environment,
  origin: HostStartOrigin,
): Promise<void> {
  if (origin !== "desktop") return;
  await refuseForegroundHostRun(verb, environment, origin);
}
