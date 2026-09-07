import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  hasBorrowableRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys, uiQueryKeys } from "@/lib/query-keys";
import {
  observationFromStatus,
  readUpdateStatusOverBorrowedSession,
} from "@/lib/host/fleet-update/borrowed-status-read";
import {
  FLEET_IDLE_POLL_MS,
  fleetPollDelayMs,
} from "@/lib/host/fleet-update/fleet-poll-policy";
import { expiredObservation } from "@/lib/host/fleet-update/canonical-status-observation";
import {
  isRecordObservation,
  projectFleetUpdateView,
  type FleetUpdateObservation,
  type FleetUpdateWireObservation,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import type { HostRpcRegistry } from "@/lib/host";

/** Best-known update state without opening new connections. One query per host, not one for the fleet. */
export function useFleetUpdateViews(
  hostIds: ReadonlyArray<string>,
): (hostId: string) => FleetUpdateView {
  const queryClient = useQueryClient();
  const idsKey = hostIds.join("\n");
  const hostIdList = useMemo(
    () => idsKey.split("\n").filter(nonEmpty),
    [idsKey],
  );

  // Waking on it is what lets a badge appear the moment a session goes live, without a timer that asks every second for the life of the window.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRemoteSessionReadiness(onStoreChange),
    [],
  );
  const getBorrowableStamp = useCallback(
    () =>
      idsKey
        .split("\n")
        .filter(
          (hostId) => hostId.length > 0 && hasBorrowableRemoteSession(hostId),
        )
        .join("\n"),
    [idsKey],
  );
  // A string stamp because `useSyncExternalStore` compares with `Object.is`:
  // rebuilding an unchanged stamp re-renders nothing, so a readiness wake that
  // moved no listed host is free.
  const borrowableStamp = useSyncExternalStore(
    subscribe,
    getBorrowableStamp,
    getBorrowableStamp,
  );
  useRefetchHostsThatBecameBorrowable(borrowableStamp, queryClient);

  const observations = useQueries({
    queries: hostIdList.map((hostId) =>
      queryOptions({
        queryKey: uiQueryKeys.hostUpdateObservation(hostId),
        // `client` comes from the query function CONTEXT rather than from a captured `useQueryClient()`.
        // Taking it from the context leaves `hostId` as the only captured value, and that is exactly what the key holds.
        queryFn: ({ client, signal }) =>
          observeHostUpdate({
            hostId,
            queryClient: client,
            abortSignal: signal,
          }),
        // `fleetPollDelayMs` refuses the fast lane for parked, terminal and qualified views, so a retained stale reading drops back to the idle cadence rather than polling a host we have lost.
        refetchInterval: (query) => cadenceFor(query.state.data ?? null),
      }),
    ),
    combine: (results) => {
      const byHostId = new Map<string, FleetUpdateObservation>();
      results.forEach((result, index) => {
        // Positional, and safe by construction: `useQueries` returns results in
        // the order the queries were given, so index `n` is `hostIdList[n]`.
        const observation = result.data ?? null;
        if (observation !== null) byHostId.set(hostIdList[index], observation);
      });
      return byHostId;
    },
  });

  return useMemo(() => {
    return (hostId: string): FleetUpdateView => {
      const observation = observations.get(hostId) ?? null;
      const nowMs = Date.now();
      return projectFleetUpdateView({
        observation,
        nowMs,
        // Record-derived observations are never connected. Derive connected from the observation, not a constant true.
        connected:
          observation !== null &&
          !isRecordObservation(observation) &&
          nowMs <= observation.freshUntilMs,
      });
    };
  }, [observations]);
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

/** Canonical host.status first, then borrowed, then last known. A declined read is not "nothing". */
async function observeHostUpdate(input: {
  readonly hostId: string;
  readonly queryClient: QueryClient;
  readonly abortSignal: AbortSignal;
}): Promise<FleetUpdateObservation | null> {
  const previous =
    input.queryClient.getQueryData<FleetUpdateObservation | null>(
      uiQueryKeys.hostUpdateObservation(input.hostId),
    ) ?? null;
  const canonical = canonicalObservation(input);
  if (canonical !== null && Date.now() <= canonical.freshUntilMs) {
    return canonical;
  }
  const borrowed = await readUpdateStatusOverBorrowedSession({
    hostId: input.hostId,
    now: () => Date.now(),
    abortSignal: input.abortSignal,
  });
  if (borrowed !== null) return borrowed;
  return freshest(canonical, previous);
}

/**
 * Read dataUpdatedAt, not a wall clock. Errored entries are absent. Lookup the exact host.status key (empty params, no cacheKeyIdentity) or coalescing silently degrades.
 */
function canonicalObservation(input: {
  readonly hostId: string;
  readonly queryClient: QueryClient;
}): FleetUpdateWireObservation | null {
  const state = input.queryClient.getQueryState<
    ResponseOfMethod<HostRpcRegistry, "host.status">
  >(
    hostQueryKeys.method<HostRpcRegistry, "host.status">(
      input.hostId,
      "host.status",
      {},
    ),
  );
  if (state === undefined) return null;
  const status = state.data;
  if (status === undefined) return null;
  const observation = observationFromStatus({
    hostId: input.hostId,
    status,
    nowMs: state.dataUpdatedAt,
    // The enum's `local`/`selected` split names WHICH SURFACE owns a canonical read, and this hook cannot know that without a React-context value it would then have to carry in the cache key for a field nothing reads.
    source: "selected",
  });
  // An errored or paused entry is EXPIRED, not absent.
  // Discarding it here would leave this host's picker row with a bare `unknown` and no retained phase, while the Overview - reading the very same response through `observationFromCanonicalRead` - would still say "last seen downloading".
  return state.status === "error" || state.fetchStatus === "paused"
    ? expiredObservation(observation)
    : observation;
}

function freshest(
  left: FleetUpdateObservation | null,
  right: FleetUpdateObservation | null,
): FleetUpdateObservation | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.observedAtMs >= right.observedAtMs ? left : right;
}

function cadenceFor(observation: FleetUpdateObservation | null): number {
  if (observation === null) return FLEET_IDLE_POLL_MS;
  return fleetPollDelayMs(
    projectFleetUpdateView({
      observation,
      nowMs: Date.now(),
      // Cadence-only, and it cannot change the answer: `connected` splits
      // `restarting` from `reconnecting`, and `fleetPollDelayMs` puts both in
      // the same lane. Pinned by a test so the claim stays true.
      connected: true,
    }),
  );
}

/** Refetch a host the moment it becomes borrowable, instead of leaving its badge blank until the idle cadence comes round up to a minute later. */
function useRefetchHostsThatBecameBorrowable(
  borrowableStamp: string,
  queryClient: QueryClient,
): void {
  const previousRef = useRef<ReadonlySet<string>>(new Set<string>());
  useEffect(() => {
    const next = new Set(borrowableStamp.split("\n").filter(nonEmpty));
    const gained = [...next].filter(
      (hostId) => !previousRef.current.has(hostId),
    );
    previousRef.current = next;
    for (const hostId of gained) {
      void queryClient.invalidateQueries({
        queryKey: uiQueryKeys.hostUpdateObservation(hostId),
      });
    }
  }, [borrowableStamp, queryClient]);
}
