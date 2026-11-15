import { useCallback, useMemo, useSyncExternalStore } from "react";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useHostClient } from "@/lib/host";

/**
 * Whose computer the surface's host is: a team's (a remote team row that is
 * not a sandbox, or this machine when the registry says it is a team's, the
 * person reaching it as a member, never as its owner), not a team's, or not
 * known yet: this machine while the registry has not answered, pending or
 * failed with no earlier answer.
 */
export type WindowHostOwnership = "team" | "not-team" | "unknown";

/**
 * Personal is never changed through a team's computer, and a call the
 * computer cannot check the caller's seat for is not offered through one;
 * a caller treats `unknown` as it treats `team` until the registry answers.
 */
export function useWindowHostOwnership(): WindowHostOwnership {
  const client = useHostClient();
  const registered = useRegisteredHosts();
  const teamComputerIds = useMemo(
    () =>
      registered.data === undefined
        ? null
        : new Set(
            (registered.data?.hosts ?? [])
              .filter((host) => host.owner?.kind === "team")
              .map((host) => host.hostId),
          ),
    [registered.data],
  );
  const read = useCallback((): WindowHostOwnership => {
    const entry = client.getActiveHost();
    if (entry === null) return "not-team";
    if (isRemoteHostDirectoryEntry(entry)) {
      return entry.sandbox === null && entry.owner?.kind === "team"
        ? "team"
        : "not-team";
    }
    if (entry.kind !== "local") return "not-team";
    if (teamComputerIds === null) return "unknown";
    return teamComputerIds.has(entry.hostId) ? "team" : "not-team";
  }, [client, teamComputerIds]);
  return useSyncExternalStore(subscribeAnyHostRowChanged, read, read);
}
