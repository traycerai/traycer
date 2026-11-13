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
 * Asks `hostId` again for every read it answered with a transient cloud
 * failure, once. Run when that host's doorbell rings.
 *
 * Bounded by the cache, not by time: one ring re-asks each such read at most
 * once, and skips one whose re-ask is still in flight, so a second ring
 * during the first's re-asks adds none. Only reads with an observer refetch;
 * one with none is marked stale and asks on its next mount. Mutations live in
 * the mutation cache and are never re-sent. Another host's reads are outside
 * the key scope, so a ring never re-asks a read its host did not answer.
 *
 * The reads are chosen when it is called. It resolves once their re-asks
 * have answered, and never rejects.
 */
export async function sweepTransientCloudFailures(
  client: QueryClient,
  hostId: string,
): Promise<void> {
  const queryKey = queryKeys.hostScope(hostId);
  const stranded = new Set(
    client
      .getQueryCache()
      .findAll({ queryKey })
      .filter(
        (query) =>
          isTransientlyFailedRead(query) && !attemptInFlightHasNotFailed(query),
      ),
  );
  if (stranded.size === 0) return;
  const predicate = (query: Query): boolean => stranded.has(query);
  // A read in TanStack's retry backoff is still `fetching`; invalidating it
  // alone would only mark it stale. Cancel first, as the recovery sweep does.
  await client.cancelQueries({ queryKey, predicate });
  await client.invalidateQueries({ queryKey, predicate });
}
