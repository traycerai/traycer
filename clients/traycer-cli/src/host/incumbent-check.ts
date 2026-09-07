import { probeHostReachable } from "@traycer-clients/shared/host-client/host-activity-probe";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "./pid-metadata";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import type { Environment } from "../runner/environment";

// Best-effort "is a host already serving this data dir?" probe, used by the supervisor to avoid stacking a second host on top of a live one.
// This is NOT mutual exclusion, and callers must not treat it as such.

export interface IncumbentHost {
  readonly pid: number;
  readonly version: string;
  readonly websocketUrl: string;
}

/** Live incumbent for this data dir, or null. Unreadable pid metadata is not absence. */
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
  // `mismatch` - the pid was recycled onto an unrelated occupant, so whatever answered the endpoint is not this record's host.
  // `dead` - the recorded process is gone despite something answering that port.
  if (identity === "mismatch" || identity === "dead") {
    return null;
  }
  return {
    pid: metadata.pid,
    version: metadata.version,
    websocketUrl: metadata.websocketUrl,
  };
}
