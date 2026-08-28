import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";

export interface CommGraphOriginHostLookup {
  findById(hostId: string): HostDirectoryEntry | null;
}

/**
 * Cloud rows stay readable when their origin is offline; only source jumps
 * gate. Parametric over the ready-session answer because the jump hook that
 * consumes this is a render path: it subscribes to session readiness and
 * threads the current answer through, rather than letting the ambient
 * cache read freeze inside its memoized snapshot.
 */
export function isCommGraphOriginAvailable(
  directory: CommGraphOriginHostLookup,
  event: CommGraphEvent,
  hasReadySession: boolean,
): boolean {
  return (
    dialableHostEndpointFor(
      directory.findById(event.hostId),
      hasReadySession,
    ) !== null
  );
}
