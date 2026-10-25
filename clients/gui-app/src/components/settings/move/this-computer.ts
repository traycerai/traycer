import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useHostClientForHostId,
  useHostDirectoryEntryForHostId,
} from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The computer this app runs on, as the retrospective sheet's show-once and
 * the Start toast address it: its host id, its name, and a client that names
 * it. All `null` on a shell with no local host.
 */
export interface ThisComputer {
  readonly hostId: string | null;
  readonly hostName: string;
  readonly client: HostClient<HostRpcRegistry> | null;
}

const UNNAMED = "this computer";

export function useThisComputer(): ThisComputer {
  const hostId = useReactiveLocalHostId();
  // `null` would resolve the window's following client, which may name
  // another host; this computer has none to offer then.
  const client = useHostClientForHostId(hostId);
  const label = useHostDirectoryEntryForHostId(hostId)?.label.trim() ?? "";
  return {
    hostId,
    hostName: label.length > 0 ? label : UNNAMED,
    client: hostId === null ? null : client,
  };
}
