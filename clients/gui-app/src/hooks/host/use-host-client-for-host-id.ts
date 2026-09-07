import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";

/** null follows effective. An explicit id always gets an identity requester, even when it currently matches effective. */
export function useHostClientForHostId(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const followingClient = useHostClient();
  const binding = useHostBinding();
  const namedClient = useMemo(
    () => (hostId === null ? null : resolveNamedHostClient(binding, hostId)),
    [binding, hostId],
  );
  return hostId === null ? followingClient : namedClient;
}

/**
 * One lookup for the live directory row of an explicit host id. A second copy for streams would let unary and stream clients disagree about which machine the id names.
 */
export function useHostDirectoryEntryForHostId(
  hostId: string | null,
): HostDirectoryEntry | null {
  return useHostDirectoryEntry(hostId);
}
