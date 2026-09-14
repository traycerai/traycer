import type { UseQueryResult } from "@tanstack/react-query";
import type { ProvidersFallbackPolicyGetResponse } from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable identities so the host-scoped query key stays referentially constant
// across renders.
const FALLBACK_POLICY_PARAMS = {};
const IN_FLIGHT_COUNT_CACHE_IDENTITY = ["inFlightCount"] as const;

/**
 * The Fallback page's "N in progress right now", kept current while the page
 * is open. Read `inFlightCount` off it and nothing else.
 *
 * The count rides on `providers.fallbackPolicy.get`, and the policy read is
 * read once (see `useFallbackPolicyQuery`), so a count taken from it is as old
 * as the page. Seen live: a hold that armed while the page was opening kept
 * "1 in progress right now" on screen for minutes after it had switched. This
 * reads the same method on the table's fixed cadence (`poll: true`), under its
 * OWN cache entry:
 *
 *  - its own entry, because the policy's entry is where `set` and
 *    `restoreTierGroups` write their responses, and a poll landing after one
 *    of those writes would put the pre-save policy back for the next mount to
 *    seed from;
 *  - holding the WHOLE response, not just the number. Those two writers
 *    address every entry under the method's scope (`setQueriesData` on
 *    `hostQueryKeys.methodScope`), this one included, and their updaters
 *    spread the previous value as a response - a cached number would come
 *    back from the first save as `{ policy, storedPolicyUnreadable }`, and the
 *    page would print it. In the response's shape, a save rewrites this
 *    entry's `policy` (which nothing reads) and leaves its count alone.
 *
 * Polling stops while the window is hidden (a fixed cadence never runs in the
 * background), and a failed poll keeps the last count - the best answer the
 * page has, replaced by the next tick.
 */
export function useFallbackInFlightCountQuery(): UseQueryResult<
  ProvidersFallbackPolicyGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: IN_FLIGHT_COUNT_CACHE_IDENTITY,
    client,
    method: "providers.fallbackPolicy.get",
    params: FALLBACK_POLICY_PARAMS,
    options: { poll: true },
  });
}
