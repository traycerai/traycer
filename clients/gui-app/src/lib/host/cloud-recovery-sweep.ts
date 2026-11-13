import type {
  Query,
  QueryCacheNotifyEvent,
  QueryClient,
} from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  attemptInFlightHasNotFailed,
  isActiveRefetchExempt,
} from "@/lib/host/query-invalidator";
import { isTransientCloudFailure } from "@/lib/host/transient-cloud-failure";

/**
 * A read whose last answer was a transient cloud failure. One that holds data
 * stays one while a re-ask is in flight (TanStack keeps `status: "error"`
 * beside the data until an answer lands); one with no data is `pending`
 * meanwhile. The cache-only carve-outs of the recovery sweep are never one.
 */
export function isTransientlyFailedRead(query: Query): boolean {
  return (
    query.state.status === "error" &&
    isTransientCloudFailure(query.state.error) &&
    !isActiveRefetchExempt(query)
  );
}

/** A ring remembered for one attempt of one read. */
interface OwedRing {
  readonly query: Query;
  /** The attempt in flight when the ring came (`Query.promise`). */
  readonly attempt: Promise<unknown> | undefined;
}

/** Per client: what the sweeps have claimed, and the rings they still owe. */
interface SweepState {
  /**
   * The reads a sweep has chosen and not finished re-asking, each `true` once
   * its ask has started.
   */
  readonly claimed: Map<Query, boolean>;
  /**
   * The reads a ring reached while an attempt of theirs was in flight, by
   * query hash: each is re-asked once if that same attempt ends in a
   * transient failure. An attempt that replaced it (a reset, or a refetch
   * that cancels a read holding data) began after the ring and owes nothing.
   * Keyed by hash so a cache event resolves to the read held here.
   */
  readonly owed: Map<string, OwedRing>;
  /**
   * The query-cache listener that learns when an owed read's attempt ends,
   * for an attempt no sweep started; held only while a ring is owed.
   */
  stopListening: (() => void) | null;
}

const sweeps = new WeakMap<QueryClient, SweepState>();

function sweepStateOf(client: QueryClient): SweepState {
  const existing = sweeps.get(client);
  if (existing !== undefined) return existing;
  const created: SweepState = {
    claimed: new Map(),
    owed: new Map(),
    stopListening: null,
  };
  sweeps.set(client, created);
  return created;
}

/**
 * Asks `hostId` again for every read it answered with a transient cloud
 * failure, once. Run when that host's doorbell rings.
 *
 * Bounded by the cache, not by time: one ring re-asks each such read at most
 * once. Only reads with an observer refetch; one with none is marked stale
 * and asks on its next mount. Mutations live in the mutation cache and are
 * never re-sent. Another host's reads are outside the key scope, so a ring
 * never re-asks a read its host did not answer.
 *
 * The reads are chosen, and claimed against later sweeps, synchronously when
 * it is called: a ring that arrives before this sweep's cancel resumes cannot
 * choose them again and restart their re-ask. Each read is released when its
 * own re-ask answers. It resolves once all of them have, and never rejects.
 *
 * A ring never restarts an attempt in flight: a sweep's own re-ask that has
 * started asking, or a refetch from elsewhere (Retry, a mount). The edge can
 * overtake that attempt's answer - the doorbell and the reads travel on
 * separate sockets - so the ring is remembered for the read instead, once
 * however many rings come, and spent as one re-ask when that attempt ends in
 * a transient failure. It is dropped when the attempt succeeds, fails for any
 * other reason, or is replaced by a later attempt, or when a later ring
 * chooses the read first. A read claimed whose ask has not started yet owes
 * nothing: that ask comes after the ring.
 *
 * Claims and remembered rings belong to the Query object, not to its key. A
 * read removed from the cache while its re-ask is in flight retires that
 * re-ask: it acts on nothing a same-key replacement owns.
 */
export async function sweepTransientCloudFailures(
  client: QueryClient,
  hostId: string,
): Promise<void> {
  const state = sweepStateOf(client);
  const chosen: Query[] = [];
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: queryKeys.hostScope(hostId) })) {
    const asking = state.claimed.get(query);
    if (asking === undefined) {
      if (
        isTransientlyFailedRead(query) &&
        !attemptInFlightHasNotFailed(query)
      ) {
        chosen.push(query);
      } else if (query.state.fetchStatus === "fetching") {
        oweRing(client, state, query);
      }
    } else if (asking) {
      oweRing(client, state, query);
    }
  }
  for (const query of chosen) {
    takeOwedRing(state, query);
    state.claimed.set(query, false);
  }
  stopListeningWhenNothingOwed(state);
  await Promise.all(chosen.map((query) => reAsk(client, state, query)));
}

/**
 * Re-asks one claimed read, and once more if a ring reached that same ask in
 * flight and it failed transiently; then releases it.
 *
 * It works by key, so before each step it checks that its read is still the
 * cache's entry for that key: once the read is removed, a cancel or an
 * invalidate by key would reach a same-key replacement, and the re-ask
 * retires instead.
 */
async function reAsk(
  client: QueryClient,
  state: SweepState,
  query: Query,
): Promise<void> {
  const filters = { queryKey: query.queryKey, exact: true };
  try {
    for (;;) {
      if (!isCurrentEntry(client, query)) return;
      state.claimed.set(query, false);
      // A read in TanStack's retry backoff is still `fetching`; invalidating
      // it alone would only mark it stale. Cancel first, as the recovery
      // sweep does.
      await client.cancelQueries(filters);
      if (!isCurrentEntry(client, query)) return;
      state.claimed.set(query, true);
      await client.invalidateQueries(filters);
      if (!isCurrentEntry(client, query)) return;
      if (!takeOwedRing(state, query) || !isTransientlyFailedRead(query)) {
        return;
      }
    }
  } finally {
    // Each read's own answer releases it: a read that failed again is the
    // next ring's to ask, however long another read of the sweep takes.
    state.claimed.delete(query);
    takeOwedRing(state, query);
    stopListeningWhenNothingOwed(state);
  }
}

/** Whether `query` is still the cache's entry for its key. */
function isCurrentEntry(client: QueryClient, query: Query): boolean {
  return client.getQueryCache().get(query.queryHash) === query;
}

/**
 * Takes the ring owed to `query` itself, if any, never another read's. True
 * when it was owed for the attempt `query` made last, the one whose end is
 * being settled: a ring whose attempt was replaced is taken and not spent.
 */
function takeOwedRing(state: SweepState, query: Query): boolean {
  const owed = state.owed.get(query.queryHash);
  if (owed === undefined || owed.query !== query) return false;
  state.owed.delete(query.queryHash);
  return owed.attempt === query.promise;
}

function oweRing(client: QueryClient, state: SweepState, query: Query): void {
  state.owed.set(query.queryHash, { query, attempt: query.promise });
  if (state.stopListening !== null) return;
  state.stopListening = client
    .getQueryCache()
    .subscribe((event) => settleOwedRing(client, state, event));
}

/**
 * Settles the ring owed to a read whose attempt no sweep started, when that
 * attempt ends. A claimed read's own re-ask settles its ring instead.
 */
function settleOwedRing(
  client: QueryClient,
  state: SweepState,
  event: QueryCacheNotifyEvent,
): void {
  const hash: string = event.query.queryHash;
  const owed = state.owed.get(hash);
  // The event's read itself: another object under the same key owns nothing
  // remembered here.
  if (
    owed === undefined ||
    event.query !== owed.query ||
    state.claimed.has(owed.query)
  ) {
    return;
  }
  const { query } = owed;
  if (event.type === "removed") {
    takeOwedRing(state, query);
  } else if (
    event.type === "updated" &&
    query.state.fetchStatus !== "fetching"
  ) {
    if (takeOwedRing(state, query) && isTransientlyFailedRead(query)) {
      // Claimed now, so a ring meanwhile waits for this ask; started after
      // the cache has finished telling everyone about the attempt's end.
      state.claimed.set(query, false);
      queueMicrotask(() => void reAsk(client, state, query));
    }
  } else {
    return;
  }
  stopListeningWhenNothingOwed(state);
}

function stopListeningWhenNothingOwed(state: SweepState): void {
  if (state.owed.size !== 0 || state.stopListening === null) return;
  state.stopListening();
  state.stopListening = null;
}
