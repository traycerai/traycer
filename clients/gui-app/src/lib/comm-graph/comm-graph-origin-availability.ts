import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

export interface CommGraphOriginHostLookup {
  findById(hostId: string): HostDirectoryEntry | null;
}

/** Cloud rows stay readable when their origin is offline; only source jumps gate. */
export function isCommGraphOriginAvailable(
  directory: CommGraphOriginHostLookup,
  event: CommGraphEvent,
): boolean {
  return dialableHostEndpoint(directory.findById(event.hostId)) !== null;
}
