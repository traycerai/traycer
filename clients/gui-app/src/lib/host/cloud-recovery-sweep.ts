import type { Query, QueryClient } from "@tanstack/react-query";
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

/**
 * How the attempt a ring met ended, read from that attempt's own settlement:
 * still in flight, failed transiently (the ring is spent), or ended any other
 * way (the ring is dropped).
 */
type AttemptOutcome = "in-flight" | "failed-transiently" | "ended-otherwise";

/** A ring remembered for one attempt of one read. */
interface OwedRing {
  /** The attempt in flight when the ring came (`Query.promise`). */
  readonly attempt: Promise<unknown>;
  /** Set when that attempt settles, never from the read's state. */
  outcome: AttemptOutcome;
}

/** Per client: what the sweeps have claimed, and the rings they still owe. */
interface SweepState {
  /**
   * The reads a sweep has chosen and not finished re-asking, each `true` once
   * its ask has started.
   */
  readonly claimed: Map<Query, boolean>;
  /**
   * The reads a ring reached while an attempt of theirs was in flight. Each is
   * re-asked once if that attempt itself fails transiently. It is dropped if
   * the attempt succeeds, fails otherwise, or is cancelled: by a reset, a
   * refetch that replaces it, its read's removal, or a cancel that asks
   * nothing after it. The canceller decided not to ask, and a ring does not
   * overrule it.
   */
  readonly owed: Map<Query, OwedRing>;
}

const sweeps = new WeakMap<QueryClient, SweepState>();

function sweepStateOf(client: QueryClient): SweepState {
  const existing = sweeps.get(client);
  if (existing !== undefined) return existing;
  const created: SweepState = { claimed: new Map(), owed: new Map() };
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
 * separate sockets - so the ring is remembered for that attempt instead, once
 * however many rings come. It is spent as one re-ask only if that attempt
 * itself fails transiently, as its own settlement says, and dropped when it
 * ends any other way or a later ring chooses the read first. A read claimed
 * whose ask has not started yet owes nothing: that ask comes after the ring.
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
    if (
      asking === undefined &&
      isTransientlyFailedRead(query) &&
      !attemptInFlightHasNotFailed(query)
    ) {
      chosen.push(query);
    } else if (asking !== false && query.state.fetchStatus === "fetching") {
      oweRing(client, state, query);
    }
  }
  for (const query of chosen) {
    takeOwedRing(state, query);
    state.claimed.set(query, false);
  }
  await Promise.all(chosen.map((query) => reAsk(client, state, query)));
}

/**
 * Re-asks one claimed read, and once more if a ring met that ask in flight and
 * the attempt itself failed transiently; then releases it.
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
      if (!takeOwedRing(state, query)) return;
    }
  } finally {
    // Each read's own answer releases it: a read that failed again is the
    // next ring's to ask, however long another read of the sweep takes.
    state.claimed.delete(query);
    takeOwedRing(state, query);
  }
}

/** Whether `query` is still the cache's entry for its key. */
function isCurrentEntry(client: QueryClient, query: Query): boolean {
  return client.getQueryCache().get(query.queryHash) === query;
}

/**
 * Takes the ring owed to `query`, if any. True when the attempt it met has
 * failed transiently: the ring is spent. Otherwise it is dropped.
 */
function takeOwedRing(state: SweepState, query: Query): boolean {
  const owed = state.owed.get(query);
  if (owed === undefined) return false;
  state.owed.delete(query);
  return owed.outcome === "failed-transiently";
}

/** Remembers a ring for the attempt `query` has in flight, once per attempt. */
function oweRing(client: QueryClient, state: SweepState, query: Query): void {
  const attempt = query.promise;
  // Set whenever a read is fetching; the type also allows a read never asked.
  if (attempt === undefined || state.owed.get(query)?.attempt === attempt) {
    return;
  }
  const ring: OwedRing = { attempt, outcome: "in-flight" };
  state.owed.set(query, ring);
  // A cancel rejects the attempt with TanStack's `CancelledError`, which ends
  // it otherwise: the canceller decided not to ask.
  const settle = (outcome: AttemptOutcome): void => {
    ring.outcome = outcome;
    settleOwedRing(client, state, query, ring);
  };
  void attempt.then(
    () => settle("ended-otherwise"),
    (error: unknown) =>
      settle(
        isTransientCloudFailure(error)
          ? "failed-transiently"
          : "ended-otherwise",
      ),
  );
}

/**
 * Settles the ring of an attempt no sweep started, once that attempt has
 * ended; a claimed read's own re-ask takes its ring when its ask answers. The
 * read's own fetch awaited the attempt first, so the read already shows this
 * end when a re-ask starts here.
 */
function settleOwedRing(
  client: QueryClient,
  state: SweepState,
  query: Query,
  ring: OwedRing,
): void {
  // A claimed read's re-ask takes the ring itself: a second re-ask started
  // here would overlap it, and the first one's release would leave the read
  // unclaimed while the second is still asking.
  if (state.owed.get(query) !== ring || state.claimed.has(query)) return;
  if (takeOwedRing(state, query)) void reAsk(client, state, query);
}
