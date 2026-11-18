import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { resolveHostName } from "@/components/settings/host-scope/host-scope-model";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import {
  useHostClientForHostId,
  useHostDirectoryEntryForHostId,
} from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import type { HostRpcRegistry } from "@/lib/host";
import { UNNAMED_HOST_LABEL } from "@/lib/host/host-name";

/**
 * The computer this app runs on, as the retrospective sheet's show-once, the
 * Start note and the Getting started card address it: its host id, its name,
 * and a client that names it. All `null` on a shell with no local host.
 *
 * The name is the host picker's (`resolveHostName`): the registry's name, which
 * follows a rename, then the directory label, which is the machine's own
 * hostname. Every surface that opens the move sheet names the computer the
 * same way.
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
  const entry = useHostDirectoryEntryForHostId(hostId);
  const registry = useRegisteredHosts().data;
  const item = registry?.hosts.find((host) => host.hostId === hostId) ?? null;
  const name =
    hostId === null ? UNNAMED_HOST_LABEL : resolveHostName(hostId, entry, item);
  return {
    hostId,
    hostName: name === UNNAMED_HOST_LABEL ? UNNAMED : name,
    client: hostId === null ? null : client,
  };
}
