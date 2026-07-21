import { useEffect } from "react";
import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostPendingRevisionState } from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { resolveDesktopHostPendingRevisionBridge } from "@/lib/windows/desktop-capabilities";
import type { DesktopHostPendingRevisionBridge } from "@/lib/windows/types";
import { useRunnerHost } from "@/providers/use-runner-host";

interface PendingRevisionSubscriptionState {
  eventGeneration: number;
  latestEvent: HostPendingRevisionState | null;
  readonly queryClients: Set<QueryClient>;
  subscription: { dispose(): void } | null;
}

const pendingRevisionSubscriptions = new WeakMap<
  DesktopHostPendingRevisionBridge,
  PendingRevisionSubscriptionState
>();

function acquirePendingRevisionSubscription(
  bridge: DesktopHostPendingRevisionBridge,
  queryClient: QueryClient,
): PendingRevisionSubscriptionState {
  let state = pendingRevisionSubscriptions.get(bridge);
  if (state === undefined) {
    state = {
      eventGeneration: 0,
      latestEvent: null,
      queryClients: new Set<QueryClient>(),
      subscription: null,
    };
    const stateForListener = state;
    state.subscription = bridge.onChange((next) => {
      stateForListener.eventGeneration += 1;
      stateForListener.latestEvent = next;
      for (const client of stateForListener.queryClients) {
        client.setQueryData(runnerQueryKeys.hostPendingRevision(bridge), next);
      }
    });
    pendingRevisionSubscriptions.set(bridge, state);
  }
  state.queryClients.add(queryClient);
  return state;
}

function releasePendingRevisionSubscription(
  bridge: DesktopHostPendingRevisionBridge,
  queryClient: QueryClient,
  state: PendingRevisionSubscriptionState,
): void {
  state.queryClients.delete(queryClient);
  if (state.queryClients.size !== 0) return;
  state.subscription?.dispose();
  pendingRevisionSubscriptions.delete(bridge);
}

async function getPendingRevisionSnapshot(
  bridge: DesktopHostPendingRevisionBridge,
): Promise<HostPendingRevisionState> {
  const stateBeforeSnapshot = pendingRevisionSubscriptions.get(bridge);
  const eventGeneration = stateBeforeSnapshot?.eventGeneration ?? 0;
  const snapshot = await bridge.get();
  const stateAfterSnapshot = pendingRevisionSubscriptions.get(bridge);
  if (
    stateAfterSnapshot !== undefined &&
    stateAfterSnapshot.eventGeneration !== eventGeneration &&
    stateAfterSnapshot.latestEvent !== null
  ) {
    // The subscription is established before every snapshot fetch. A push
    // that lands while get() is in flight is newer than its response and
    // must win, including when the query otherwise remains fresh forever.
    return stateAfterSnapshot.latestEvent;
  }
  return snapshot;
}

export function useRunnerHostPendingRevisionQuery(): UseQueryResult<HostPendingRevisionState> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const bridge = resolveDesktopHostPendingRevisionBridge(runnerHost);
  const queryKey = runnerQueryKeys.hostPendingRevision(bridge);
  const query = useQuery(
    queryOptions({
      queryKey,
      queryFn: async () => {
        if (bridge === null) {
          throw new Error("Pending host revision status is unavailable");
        }
        return getPendingRevisionSnapshot(bridge);
      },
      // The effect below owns the ordering: it subscribes first, then starts
      // this query via QueryClient. Keeping observer auto-fetch disabled
      // prevents a renderer reload from taking its snapshot before onChange
      // is live.
      enabled: false,
      staleTime: Infinity,
    }),
  );

  useEffect(() => {
    if (bridge === null) return;
    const state = acquirePendingRevisionSubscription(bridge, queryClient);
    // Explicit staleTime forces a snapshot on each Settings mount despite the
    // observer's Infinity freshness policy. The subscription is already
    // active, and getPendingRevisionSnapshot rejects an older response.
    void queryClient
      .fetchQuery(
        queryOptions({
          queryKey: runnerQueryKeys.hostPendingRevision(bridge),
          queryFn: () => getPendingRevisionSnapshot(bridge),
          staleTime: 0,
        }),
      )
      .catch(() => undefined);
    return () => {
      releasePendingRevisionSubscription(bridge, queryClient, state);
    };
  }, [bridge, queryClient]);

  return query;
}
