import { useCallback, useMemo, useSyncExternalStore } from "react";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useHostClient } from "@/lib/host";

/**
 * Whether the surface's host is a team's computer: a remote team row that is
 * not a sandbox, or this machine when the registry says it is a team's (the
 * person reaches it as a member, never as its owner).
 *
 * Personal is never changed through a team's computer, and a call the
 * computer cannot check the caller's seat for is not offered through one.
 */
export function useWindowHostIsTeamComputer(): boolean {
  const client = useHostClient();
  const registered = useRegisteredHosts();
  const teamComputerIds = useMemo(
    () =>
      new Set(
        (registered.data?.hosts ?? [])
          .filter((host) => host.owner?.kind === "team")
          .map((host) => host.hostId),
      ),
    [registered.data],
  );
  const read = useCallback(() => {
    const entry = client.getActiveHost();
    if (entry === null) return false;
    if (isRemoteHostDirectoryEntry(entry)) {
      return entry.sandbox === null && entry.owner?.kind === "team";
    }
    return entry.kind === "local" && teamComputerIds.has(entry.hostId);
  }, [client, teamComputerIds]);
  return useSyncExternalStore(subscribeAnyHostRowChanged, read, read);
}
