import type { Environment } from "../runner/environment";
import { findLiveIncumbentHost } from "./incumbent-check";
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
