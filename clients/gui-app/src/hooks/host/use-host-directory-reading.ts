import { createContext, use, useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostDirectoryListQuery } from "@/hooks/host/use-host-directory-list-query";

/**
 * The host directory as a surface reads it: its entries, or `undefined` with
 * `loading` telling "not answered yet" from "no directory bound" (the query is
 * disabled without a binding, e.g. under a test harness that mounts no host
 * provider).
 */
export interface HostDirectoryReading {
  readonly entries: readonly HostDirectoryEntry[] | undefined;
  readonly loading: boolean;
}

/**
 * A reading held once by a panel for every row under it. `null` (the
 * default) means no panel provides one and each consumer reads for itself.
 *
 * The directory query is deliberately stale on mount, so every consumer that
 * subscribes to it refetches on mount and is notified on every refetch. A
 * sidebar branch of forty rows, each reading reachability for its owner host,
 * is forty observers, forty mount refetches and forty `onChange` listeners -
 * and one directory emit re-renders all forty. The panel subscribes once and
 * provides the reading; the rows read it from here, with no observer of
 * their own, and the provider's single subscription is what keeps them live.
 */
export const HostDirectoryReadingContext =
  createContext<HostDirectoryReading | null>(null);

/**
 * The provided reading when a panel above holds one, else this consumer's
 * own subscribed reading. The result is reference-stable while its two
 * members are, so a consumer may list it as a memo dependency.
 */
export function useHostDirectoryReading(): HostDirectoryReading {
  const provided = use(HostDirectoryReadingContext);
  const own = useHostDirectoryListQuery(provided === null);
  // The own query result tracks which of its properties a render reads and
  // notifies only on those. `fetchStatus` matters only while there is no
  // `data` yet, so it is read only then: reading it on every render tracked
  // it forever, and every background refetch re-rendered every consumer with
  // the data unchanged.
  const entries = provided === null ? own.data : provided.entries;
  const loading =
    provided === null
      ? entries === undefined && own.fetchStatus !== "idle"
      : provided.loading;
  return useMemo(() => ({ entries, loading }), [entries, loading]);
}
