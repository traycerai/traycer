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

/** One re-ask of a read by a sweep. */
interface Claim {
  /**
   * The read's latest attempt when this re-ask's cancel began: the one that
   * cancel ends, or the last that ended. Any other is newer.
   */
  after: Promise<unknown> | undefined;
  /** The attempt this re-ask's ask started; none until it starts. */
  attempt: Promise<unknown> | undefined;
  /**
   * A ring found the read failed after that attempt ended, before this re-ask
   * released it: the re-ask asks once more for that ring, unless an attempt
   * has begun since.
   */
  rungAfterEnd: boolean;
}

/**
 * Per client: what the sweeps have claimed, and the rings they still owe.
 *
 * A ring is owed to exactly one attempt, the one in flight on that read when
 * it came, and to nothing else:
 * 1. every take names the attempt, and a claim is one re-ask's, with its own
 *    attempt;
 * 2. a ring is settled only by its own attempt's outcome;
 * 3. when that attempt has failed transiently, the ring is spent only if the
 *    attempt is still the read's latest; an attempt begun after the ring
 *    already answers it, so the ring is dropped;
 * 4. a ring never cancels or restarts an attempt begun after it.
 */
interface SweepState {
  /** The reads a sweep has chosen and not finished re-asking. */
  readonly claimed: Map<Query, Claim>;
  /**
   * The ring owed to each read, for one attempt. It is dropped if that
   * attempt succeeds, fails otherwise, or is cancelled: by a reset, a refetch
   * that replaces it, its read's removal, or a cancel that asks nothing after
   * it. The canceller decided not to ask, and a ring does not overrule it.
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
 * however many rings come, under the rules on `SweepState`. A read claimed
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
    // A cache-only carve-out is never re-asked, so a ring neither chooses it
    // nor is owed to an attempt of its own.
    if (isActiveRefetchExempt(query)) continue;
    const claim = state.claimed.get(query);
    if (claim === undefined || supersedes(query, claim)) {
      // Not held, or held by a re-ask a newer attempt has replaced, which
      // stops at that attempt without acting.
      if (
        isTransientlyFailedRead(query) &&
        !attemptInFlightHasNotFailed(query)
      ) {
        chosen.push(query);
      } else {
        oweRing(client, state, query);
      }
    } else if (claim.attempt !== undefined) {
      if (attemptInFlight(query) !== undefined) {
        oweRing(client, state, query);
      } else if (isTransientlyFailedRead(query)) {
        claim.rungAfterEnd = true;
      }
    }
    // Otherwise the re-ask's ask has not started, and comes after the ring.
  }
  const asks = chosen.map((query) => {
    // The ask about to start comes after this ring, and answers any ring owed
    // to the attempt it ends.
    takeOwedRing(state, query, query.promise);
    const claim: Claim = newClaim();
    state.claimed.set(query, claim);
    return { query, claim };
  });
  await Promise.all(
    asks.map(({ query, claim }) => reAsk(client, state, query, claim)),
  );
}

/**
 * Re-asks one claimed read, and once more if a ring met that ask in flight,
 * the attempt itself failed transiently and nothing has asked since; then
 * releases it.
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
  claim: Claim,
): Promise<void> {
  const filters = { queryKey: query.queryKey, exact: true };
  try {
    for (;;) {
      if (!isCurrentEntry(client, query)) return;
      claim.attempt = undefined;
      claim.after = query.promise;
      // A read in TanStack's retry backoff is still `fetching`; invalidating
      // it alone would only mark it stale. Cancel first, as the recovery
      // sweep does.
      await client.cancelQueries(filters);
      if (!isCurrentEntry(client, query)) return;
      // An attempt begun during the cancel began after the ring: it answers
      // the ring, and is not restarted for it.
      if (query.promise !== claim.after) return;
      const asked = client.invalidateQueries(filters);
      claim.attempt = attemptInFlight(query);
      await asked;
      if (!isCurrentEntry(client, query)) return;
      // An attempt begun since answers the rings, and is not cancelled for
      // them.
      if (query.promise !== claim.attempt) return;
      const spent = takeOwedRing(state, query, claim.attempt);
      const rung = claim.rungAfterEnd;
      claim.rungAfterEnd = false;
      if (!spent && !rung) return;
    }
  } finally {
    // Each read's own answer releases it: a read that failed again is the
    // next ring's to ask, however long another read of the sweep takes.
    if (state.claimed.get(query) === claim) state.claimed.delete(query);
    takeOwedRing(state, query, claim.attempt);
  }
}

/** Whether `query` is still the cache's entry for its key. */
function isCurrentEntry(client: QueryClient, query: Query): boolean {
  return client.getQueryCache().get(query.queryHash) === query;
}

function newClaim(): Claim {
  return { after: undefined, attempt: undefined, rungAfterEnd: false };
}

/**
 * Whether an attempt newer than `claim`'s re-ask knows about has begun on
 * `query`: one started during its cancel, or after its ask's attempt.
 */
function supersedes(query: Query, claim: Claim): boolean {
  return claim.attempt === undefined
    ? query.promise !== claim.after
    : query.promise !== claim.attempt;
}

/** The attempt `query` has in flight, if any. */
function attemptInFlight(query: Query): Promise<unknown> | undefined {
  return query.state.fetchStatus === "fetching" ? query.promise : undefined;
}

/**
 * Takes the ring owed to `attempt` of `query`, if any; never a ring owed to
 * another attempt. True when that attempt failed transiently.
 */
function takeOwedRing(
  state: SweepState,
  query: Query,
  attempt: Promise<unknown> | undefined,
): boolean {
  const owed = state.owed.get(query);
  if (owed === undefined || owed.attempt !== attempt) return false;
  state.owed.delete(query);
  return owed.outcome === "failed-transiently";
}

/**
 * Remembers a ring for the attempt `query` has in flight, once per attempt.
 * A ring still held for an earlier attempt is replaced: the attempt in flight
 * began after it.
 */
function oweRing(client: QueryClient, state: SweepState, query: Query): void {
  const attempt = attemptInFlight(query);
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
 * Settles a ring once its attempt has ended, unless the re-ask that started
 * that attempt will: that re-ask takes it when its ask answers. The read's own
 * fetch awaited the attempt first, so the read already shows this end when a
 * re-ask starts here.
 */
function settleOwedRing(
  client: QueryClient,
  state: SweepState,
  query: Query,
  ring: OwedRing,
): void {
  if (state.owed.get(query) !== ring) return;
  // A second re-ask started here would overlap the one that owns the ring,
  // and that one's sweep would resolve before this ask answers.
  if (state.claimed.get(query)?.attempt === ring.attempt) return;
  const failedTransiently = takeOwedRing(state, query, ring.attempt);
  if (!failedTransiently || query.promise !== ring.attempt) return;
  const claim: Claim = newClaim();
  state.claimed.set(query, claim);
  void reAsk(client, state, query, claim);
}
