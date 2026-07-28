import { probeHostReachable } from "@traycer-clients/shared/host-client/host-activity-probe";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "./pid-metadata";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import type { Environment } from "../runner/environment";

// Best-effort "is a host already serving this data dir?" probe, used by the
// supervisor to avoid stacking a second host on top of a live one.
//
// This is NOT mutual exclusion, and callers must not treat it as such. It is
// a read-only observation with no reservation behind it: two callers that
// observe simultaneously both see the same answer. See the guard in
// `commands/host-start.ts` for exactly which races it does and does not
// cover.
//
// The install lifecycle owns intentional version replacement (`beforeSwap`
// stops a running host before the swap). This probe exists only for the
// case that has no install in it at all.

export interface IncumbentHost {
  readonly pid: number;
  readonly version: string;
  readonly websocketUrl: string;
}

/**
 * Returns the host already serving this environment's data dir, or `null`
 * when the caller should go ahead and spawn.
 *
 * Deliberately biased toward spawning: a false positive means the supervisor
 * declines and the machine is left with NO host, which is far worse than the
 * duplicate it prevents.
 *
 * Order matters. Endpoint reachability comes FIRST and is the positive
 * liveness signal - something must actually be serving the recorded loopback
 * endpoint. Only then does process identity run, and only to rule out a
 * positively demonstrated recycled-PID impostor.
 *
 * `getPublishedProcessIdentityVerdict` is used rather than `isProcessAlive`
 * on purpose. `isProcessAlive` is `probeProcessLiveness(pid) !== "dead"`, so
 * it reports `true` for an *indeterminate* OS probe and cannot distinguish
 * the publisher from an unrelated process that inherited a recycled pid.
 * The verdict helper compares the process start time against pid.json's
 * publication time and reports `mismatch` for exactly that impostor case.
 *
 * `indeterminate` deliberately KEEPS the incumbent: a failed OS probe is not
 * evidence that a healthy, answering endpoint is down. Taking the opposite
 * reading here would spawn a duplicate every time `ps` was slow.
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
  if (!(await probeHostReachable(metadata.websocketUrl))) {
    return null;
  }
  const identity = await getPublishedProcessIdentityVerdict(
    metadata.pid,
    metadata.processStartIdentity,
  );
  // `mismatch` - the pid was recycled onto an unrelated occupant, so whatever
  // answered the endpoint is not this record's host. `dead` - the recorded
  // process is gone despite something answering that port. Both mean the
  // record no longer describes a host we should defer to.
  if (identity === "mismatch" || identity === "dead") {
    return null;
  }
  return {
    pid: metadata.pid,
    version: metadata.version,
    websocketUrl: metadata.websocketUrl,
  };
}
