import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isAdministrableRoute } from "@/components/settings/host-scope/host-scope-model";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteHostsPlanRestricted } from "@/hooks/host/use-remote-hosts-plan-gate";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";

const EMPTY_ENTRIES: readonly HostDirectoryEntry[] = [];
const EMPTY_HOST_IDS: readonly string[] = [];

export interface ConnectableHosts {
  /**
   * Every host this client can dial RIGHT NOW - the ids for which
   * `HostScopeOption.connectable` would be true.
   */
  readonly hostIds: readonly string[];
  /**
   * The directory has ANSWERED. A disabled query (no host-runtime binding)
   * counts as answered - there is no route to anything, and waiting on a
   * request that will never be made would hold a caller open forever.
   *
   * Separate from an empty `hostIds` because a caller deciding the SHAPE of
   * the fleet must not read "still loading" as "one host": that reading is
   * how a multi-host account silently gets the single-host path.
   */
  readonly resolved: boolean;
}

/**
 * The fleet's shape, asked of the runtime directory alone.
 *
 * `useHostOptions` is the richer answer and stays THE list every host PICKER
 * renders from - this does not compete with it and deliberately builds no
 * rows, no names and no status words. It exists for the one question a
 * surface may need BEFORE it can afford that hook: how many hosts can this
 * client dial? `useHostOptions` reads the cloud registry and the local runner
 * host, so mounting it means mounting a `<RunnerHostProvider>` dependency in
 * whatever renders it - fine inside a picker that is only mounted when a
 * person opened one, wrong for chrome that is mounted for the life of a panel.
 *
 * The two cannot disagree: `connectable` IS `isAdministrableRoute`, and this
 * calls the same function over the same directory entries. A registry-only
 * host (no directory entry) is non-connectable in `useHostOptions` too, so its
 * absence here is the same verdict, not a narrower list.
 */
export function useConnectableHostIds(): ConnectableHosts {
  const directory = useHostDirectoryList();
  const entries = directory.data ?? EMPTY_ENTRIES;
  const planRestricted = useRemoteHostsPlanRestricted();
  const hostIds = useMemo(
    () => entries.map((entry) => entry.hostId),
    [entries],
  );
  // Subscribed rather than read ambiently, for the reason `useHostOptions`
  // gives: a session dying or appearing under an offline / plan-restricted
  // entry has to move this answer, and a cache read frozen in a memo cannot.
  const hasLiveSession = useRemoteSessionsPollReadiness(hostIds);
  const connectableHostIds = useMemo(() => {
    const connectable = entries.flatMap((entry) =>
      isAdministrableRoute(entry, planRestricted, hasLiveSession(entry.hostId))
        ? [entry.hostId]
        : [],
    );
    return connectable.length === 0 ? EMPTY_HOST_IDS : connectable;
  }, [entries, hasLiveSession, planRestricted]);
  return {
    hostIds: connectableHostIds,
    // `isLoading` is `pending && fetching`, which is false for a settled
    // query, for an errored one, and for a disabled one - exactly the three
    // ways "the directory has said what it is going to say" can be true.
    resolved: !directory.isLoading,
  };
}
