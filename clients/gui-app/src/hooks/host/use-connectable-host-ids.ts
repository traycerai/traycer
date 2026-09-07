import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isAdministrableRoute } from "@/components/settings/host-scope/host-scope-model";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { useHostLeases } from "@/hooks/host/use-host-lease";

const EMPTY_ENTRIES: readonly HostDirectoryEntry[] = [];
const EMPTY_HOST_IDS: readonly string[] = [];

export interface ConnectableHosts {
  /** Every host this client can dial RIGHT NOW - the ids for which `HostScopeOption.connectable` would be true. */
  readonly hostIds: readonly string[];
  /** A disabled query (no host-runtime binding) counts as answered - there is no route to anything, and waiting on a request that will never be made would hold a caller open forever. */
  readonly resolved: boolean;
}

/** Directory-only connectable ids. Does not mount RunnerHostProvider. Same isAdministrableRoute as useHostOptions. */
export function useConnectableHostIds(): ConnectableHosts {
  const directory = useHostDirectoryList();
  const entries = directory.data ?? EMPTY_ENTRIES;
  const leases = useHostLeases();
  const hostIds = useMemo(
    () => entries.map((entry) => entry.hostId),
    [entries],
  );
  // Subscribed rather than read ambiently, for the reason `useHostOptions`
  // gives: a session dying or appearing under an offline / plan-restricted
  // entry has to move this answer, and a cache read frozen in a memo cannot.
  const hasLiveSession = useRemoteSessionsPollReadiness(hostIds);
  const connectableHostIds = useMemo(() => {
    const planRestrictedHostIds = new Set(
      leases
        .filter(
          (lease) =>
            lease.status === "dead" && lease.dead.reason === "plan-restricted",
        )
        .map((lease) => lease.hostId),
    );
    const connectable = entries.flatMap((entry) =>
      !planRestrictedHostIds.has(entry.hostId) &&
      isAdministrableRoute(entry, hasLiveSession(entry.hostId))
        ? [entry.hostId]
        : [],
    );
    return connectable.length === 0 ? EMPTY_HOST_IDS : connectable;
  }, [entries, hasLiveSession, leases]);
  return {
    hostIds: connectableHostIds,
    // `isLoading` is `pending && fetching`, which is false for a settled
    // query, for an errored one, and for a disabled one - exactly the three
    // ways "the directory has said what it is going to say" can be true.
    resolved: !directory.isLoading,
  };
}
