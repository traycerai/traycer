import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useQueryClient,
  type Query,
  type QueryCache,
  type QueryClient,
} from "@tanstack/react-query";
import { CLOUD_RECOVERED_STREAM_METHOD } from "@traycer/protocol/host/cloud-recovered-stream";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { CloudRecoveredStreamClient } from "@traycer-clients/shared/host-transport/cloud-recovered-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import {
  isTransientlyFailedRead,
  sweepTransientCloudFailures,
} from "@/lib/host/cloud-recovery-sweep";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";

/**
 * Holds one host's cloud-recovery doorbell (`cloud.recovered.subscribe`) for
 * as long as that host has a read it answered with a transient cloud failure,
 * and re-asks those reads whenever it rings.
 *
 * The doorbell is THAT host's: a read's key names the host that answered it
 * (`["host", hostId, ...]`), the subscription is dialed through that host's
 * own stream client, and a ring sweeps only that host's key scope. A host
 * with no stranded read has no subscription. A host whose manifest does not
 * carry the method is never dialed for it, and its reads keep Retry as
 * before.
 */
export function CloudRecoveryDoorbellMount(): ReactNode {
  const queryClient = useQueryClient();
  const hostIds = useHostsWithStrandedReads(queryClient);
  return hostIds.map((hostId) => (
    <HostCloudRecoveryDoorbell key={hostId} hostId={hostId} />
  ));
}

function HostCloudRecoveryDoorbell(props: {
  readonly hostId: string;
}): ReactNode {
  const { hostId } = props;
  const queryClient = useQueryClient();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const streamClient = useHostStreamClientFor(target, auth);
  const support = useDoorbellSupport(streamClient);

  useEffect(() => {
    if (streamClient === null || support === "unsupported") return;
    const wsStreamClient = streamClient;
    const hostConnection = acquireHostConnection(hostId);
    let disposed = false;
    let currentClient: CloudRecoveredStreamClient | null = null;
    const reopenLane = hostConnection.reconnect.openReopenLane(() => {
      currentClient?.close();
      currentClient = null;
      openClient();
    }, isReopenableHostStreamClose);

    function openClient(): void {
      if (disposed) return;
      let client: CloudRecoveredStreamClient | null = null;
      client = new CloudRecoveredStreamClient({
        wsStreamClient,
        // The host rings once on open, so this also covers an edge that fell
        // between the failed read and this subscription.
        onRecovered: () => {
          if (currentClient !== client) return;
          reopenLane.resetBackoff();
          void sweepTransientCloudFailures(queryClient, hostId);
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client || status !== "closed") return;
          reopenLane.scheduleAfterClose(reason);
        },
      });
      currentClient = client;
    }

    openClient();
    return () => {
      disposed = true;
      reopenLane.dispose();
      currentClient?.close();
      currentClient = null;
      hostConnection.release();
    };
  }, [hostId, queryClient, streamClient, support]);

  return null;
}

function useDoorbellSupport(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): "unknown" | "supported" | "unsupported" {
  const subscribe = useCallback(
    (listener: () => void) =>
      client === null ? () => {} : client.subscribeMethodSupport(listener),
    [client],
  );
  const getSnapshot = useCallback(
    () =>
      client === null
        ? "unknown"
        : client.getMethodSupport(CLOUD_RECOVERED_STREAM_METHOD),
    [client],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

const NO_HOSTS: readonly string[] = [];

/**
 * The hosts that answered at least one observed read with a transient cloud
 * failure, kept per cache event from the cache's current entry for the key
 * that changed, never by rescanning the cache.
 */
function useHostsWithStrandedReads(client: QueryClient): readonly string[] {
  const tracker = strandedReadTrackerFor(client.getQueryCache());
  return useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
}

const trackers = new WeakMap<QueryCache, StrandedReadTracker>();

function strandedReadTrackerFor(cache: QueryCache): StrandedReadTracker {
  const existing = trackers.get(cache);
  if (existing !== undefined) return existing;
  const created = new StrandedReadTracker(cache);
  trackers.set(cache, created);
  return created;
}

class StrandedReadTracker {
  /** Host of each stranded read, by query hash. */
  private readonly hostByHash = new Map<string, string>();
  private snapshot: readonly string[] = NO_HOSTS;
  private readonly listeners = new Set<() => void>();
  private unsubscribeCache: (() => void) | null = null;

  constructor(private readonly cache: QueryCache) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.unsubscribeCache === null) {
      for (const query of this.cache.getAll()) this.track(query);
      this.publish();
      this.unsubscribeCache = this.cache.subscribe((event) => {
        // Decided from the cache's current entry for the hash, looked up
        // typed (the event's own query is `any`). An event about another
        // Query object, such as an old read's removal announced after a
        // replacement took the key, says nothing about that entry; a read's
        // own removal leaves none.
        const { queryHash } = event.query;
        const query = this.cache.get(queryHash);
        const changed =
          query === undefined
            ? this.hostByHash.delete(queryHash)
            : this.track(query);
        if (changed) this.publish();
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.unsubscribeCache?.();
      this.unsubscribeCache = null;
      this.hostByHash.clear();
      this.snapshot = NO_HOSTS;
    };
  };

  readonly getSnapshot = (): readonly string[] => this.snapshot;

  /**
   * Records whether `query` is stranded; true when that changed.
   *
   * A stranded read stays stranded while a re-ask of it is in flight. For a
   * read with no data TanStack moves it to `pending` and clears its error for
   * the fetch; dropping it then would close the doorbell the re-ask depends
   * on, and redial it, ringing again, each time the re-ask fails.
   */
  private track(query: Query): boolean {
    const hostId = hostIdOf(query);
    const had = this.hostByHash.has(query.queryHash);
    const stranded =
      hostId !== null &&
      query.getObserversCount() > 0 &&
      (isTransientlyFailedRead(query) ||
        (had && query.state.fetchStatus !== "idle"));
    if (stranded) {
      this.hostByHash.set(query.queryHash, hostId);
      return !had;
    }
    return had && this.hostByHash.delete(query.queryHash);
  }

  private publish(): void {
    const next = [...new Set(this.hostByHash.values())].sort();
    if (
      next.length === this.snapshot.length &&
      next.every((hostId, index) => hostId === this.snapshot[index])
    ) {
      return;
    }
    this.snapshot = next.length === 0 ? NO_HOSTS : next;
    for (const listener of [...this.listeners]) listener();
  }
}

function hostIdOf(query: Query): string | null {
  const [scope, hostId] = query.queryKey;
  return scope === "host" && typeof hostId === "string" ? hostId : null;
}
