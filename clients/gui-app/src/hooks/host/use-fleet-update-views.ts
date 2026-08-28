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

/**
 * Best-known update state for every listed host, obtained WITHOUT causing a
 * single new connection.
 *
 * This is the Settings selector's whole data source, and its defining property
 * is negative: "the selector decorates every host with the best known state …
 * Settings does not silently connect to other hosts to improve their badges"
 * (experience doc, Flow B). So a host is only ever read over a session that
 * already exists, and every other host projects `unknown`, which the badge
 * renders as nothing at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE QUERY PER HOST, not one for the fleet — and the first version had it the
 * other way round.
 *
 * A single fleet-shaped query looked cheaper: one key, one map, one schedule.
 * But a cache entry is also a SCHEDULING UNIT, and one schedule for the fleet
 * means one cadence for the fleet. The old `sweepCadence` took the fastest
 * cadence any listed host had earned and applied it to all of them, with a
 * comment acknowledging exactly that. The cost is not theoretical: twenty
 * borrowable hosts and one ten-minute download had nineteen quiet machines read
 * roughly three hundred times each instead of roughly ten — one person's update
 * setting the transport cost of everybody else's computer, which is the precise
 * inversion of "two seconds only while the host itself reports an active
 * operation".
 *
 * The batch loop that used to bound the burst went with it, because four
 * `Promise.all`s of one host each bound nothing. That job now belongs to
 * `fleet-read-gate.ts`, which caps concurrent reads across the whole fleet.
 *
 * Host-keyed entries buy two more things the fleet map could not express:
 * per-host RETENTION (a declined read keeps that host's last observation
 * instead of vanishing from a rebuilt map) and COALESCING with the canonical
 * `host.status` query — the selected host and the local host are already being
 * read by the Overview and the landing banner, and reading them a second time
 * over a borrow was pure duplication.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function useFleetUpdateViews(
  hostIds: ReadonlyArray<string>,
): (hostId: string) => FleetUpdateView {
  const queryClient = useQueryClient();
  const idsKey = hostIds.join("\n");
  const hostIdList = useMemo(
    () => idsKey.split("\n").filter(nonEmpty),
    [idsKey],
  );

  // Borrowability is PUSH, not poll: the session cache reports its own
  // transitions (including the two consumer/linger edges that move only this
  // predicate). Waking on it is what lets a badge appear the moment a session
  // goes live, without a timer that asks every second for the life of the
  // window.
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
        // `client` comes from the query function CONTEXT rather than from a
        // captured `useQueryClient()`. Capturing it would put the query client
        // in this function's closure, and every closed-over value that can
        // change the result belongs in the query key — which a query client
        // manifestly does not. Taking it from the context leaves `hostId` as
        // the only captured value, and that is exactly what the key holds.
        queryFn: ({ client, signal }) =>
          observeHostUpdate({
            hostId,
            queryClient: client,
            abortSignal: signal,
          }),
        // THIS is the per-host cadence, and it reads only this host's own
        // observation. `fleetPollDelayMs` refuses the fast lane for parked,
        // terminal and qualified views, so a retained stale reading drops back
        // to the idle cadence rather than polling a host we have lost.
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
        // DERIVED from the observation rather than asserted beside it. A
        // reading we can still present as current is itself the evidence of a
        // live route, whichever leg produced it — so this cannot disagree with
        // the freshness the same object carries. The previous `connected: true`
        // was a constant, and a constant claiming a live connection is the same
        // shape of mistake as the infinite freshness deadline this round
        // removed from the Overview.
        //
        // It matters for exactly one thing: a host that said `restarting` and
        // then went quiet reads as `reconnecting`, which is what waiting for it
        // to come back actually looks like.
        // A record-derived observation is never "connected" - reading the
        // durable record is what we do BECAUSE the host is not answering. The
        // projector's record branch does not consult this value at all (it
        // passes its own `false`), so this is belt-and-braces rather than the
        // decision; stated explicitly so a future reader does not have to
        // trace the projector to know the answer here cannot be `true`.
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

/**
 * One host's observation: the canonical read if it is current, a borrowed read
 * otherwise, and whatever we already knew if neither answered.
 *
 * The order is the whole coalescing rule. A host the Overview or the landing
 * banner is already polling has a `host.status` response sitting in the cache,
 * paid for and kept fresh by that surface's own schedule; asking the same host
 * the same question again over a borrow bought nothing and cost a round trip
 * per cadence tick. So the canonical entry is consulted first and the transport
 * is touched only for hosts nobody else is reading.
 *
 * The final fallback is what makes an offline row able to say "last seen
 * downloading": a declined read means we learned NOTHING this round, which is
 * not the same as learning that there is nothing. Dropping the host from a
 * rebuilt map — as the fleet sweep did — threw away the last thing we knew at
 * the exact moment it became the only thing we had.
 */
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
 * The observation implied by the shared `host.status` cache entry, if there is
 * one.
 *
 * Reads the entry's own `dataUpdatedAt` rather than a wall clock, so the
 * freshness deadline this stamps describes when the data actually arrived. No
 * read health is synthesised here: an entry that stops being refreshed simply
 * ages past its deadline and projects the qualified `unknown`, which is the
 * same demotion every other leg gets and needs no second opinion to reach.
 *
 * An errored entry is treated as absent rather than as evidence — a failed
 * `host.status` says nothing about the update.
 *
 * ⚠ THE EXACT KEY, not the method scope, because `getQueryState` matches a key
 * rather than a prefix — and that couples this lookup to how `useHostQuery`
 * builds it: `[...hostMethod(hostId, method, params), ...cacheKeyIdentity]`.
 * Both canonical `host.status` consumers pass empty params and no
 * `cacheKeyIdentity`, so the key is exactly what this reconstructs. If either
 * ever gains a `cacheKeyIdentity`, this lookup MISSES and coalescing degrades
 * silently — every coalesced host quietly reverts to a borrowed read, correct
 * in every answer it gives and paying for a round trip that was already paid.
 * A silent efficiency regression is the kind nobody reports, so: the
 * call-count test that proves coalescing is what would catch it, and it is
 * load-bearing for that reason rather than for its own assertion.
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
    // `selected`, for every host this leg serves — including this computer's.
    // The enum's `local`/`selected` split names WHICH SURFACE owns a canonical
    // read, and this hook cannot know that without a React-context value it
    // would then have to carry in the cache key for a field nothing reads.
    // What it can know is what the enum's own wording asks for: the
    // observation came from a Settings-scoped host over its own live
    // connection. `local` belongs to the landing banner's runner leg.
    source: "selected",
  });
  // An errored or paused entry is EXPIRED, not absent. Discarding it here would
  // leave this host's picker row with a bare `unknown` and no retained phase,
  // while the Overview — reading the very same response through
  // `observationFromCanonicalRead` — would still say "last seen downloading".
  // Expiring keeps both surfaces on one story, and the projection's stale arm
  // then does what it does for every other leg.
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

/**
 * Refetch a host the moment it becomes borrowable, instead of leaving its badge
 * blank until the idle cadence comes round up to a minute later.
 *
 * Scoped to the hosts that actually CHANGED. Invalidating the whole set on any
 * readiness wake would turn one host's session going live into a fleet-wide
 * read — a smaller version of the cross-host coupling this hook was rewritten
 * to remove.
 */
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
