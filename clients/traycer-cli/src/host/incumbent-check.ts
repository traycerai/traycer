import { probeHostReachable } from "@traycer-clients/shared/host-client/host-activity-probe";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "./pid-metadata";
import { isProcessAlive } from "../store/cli-lock";
import type { Environment } from "../runner/environment";

// One host per `--host-data-dir`, enforced where the spawn happens.
//
// launchd runs at most one instance of a LABEL, but the label split
// (`ai.traycer.host` for the CLI, `ai.traycer.host.agent` for Desktop's
// SMAppService registration) means two DISTINCT labels can both invoke
// `traycer host start` against the same data dir. Both have `RunAtLoad`, so
// a machine that ends up with both registered spawns two hosts at every
// login - racing the same `pid.json`, stores, and epic file syncs, with the
// loser silently invisible to new clients.
//
// The install lifecycle already owns intentional version replacement
// (`beforeSwap` stops a running host before the swap). This check is the
// backstop for the case that has no install in it at all: two registrations
// that already exist on disk.

export interface IncumbentHost {
  readonly pid: number;
  readonly version: string;
  readonly websocketUrl: string;
}

/**
 * Returns the live host already serving this environment's data dir, or
 * `null` when the caller should go ahead and spawn.
 *
 * Deliberately biased toward spawning. A false positive here means the
 * supervisor declines and the machine is left with NO host, which is far
 * worse than the duplicate it prevents - so "present" requires two
 * independent signals: the recorded pid is alive AND something is actually
 * serving HTTP on the recorded loopback endpoint. A recycled pid clears the
 * first but not the second; a wedged host that answers nothing is treated as
 * absent so a healthy replacement can take over.
 */
export async function findLiveIncumbentHost(
  environment: Environment | undefined,
): Promise<IncumbentHost | null> {
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) {
    return null;
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    return null;
  }
  // Our own supervisor pid can never be the incumbent host; guard anyway so a
  // recycled pid that happens to match cannot deadlock the spawn path.
  if (metadata.pid === process.pid) {
    return null;
  }
  if (!isProcessAlive(metadata.pid)) {
    return null;
  }
  if (!(await probeHostReachable(metadata.websocketUrl))) {
    return null;
  }
  return {
    pid: metadata.pid,
    version: metadata.version,
    websocketUrl: metadata.websocketUrl,
  };
}
