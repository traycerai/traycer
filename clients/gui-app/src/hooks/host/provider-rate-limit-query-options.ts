import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { UseHostQueryOptions } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

/**
 * Independent background refresh cadence for the `httpFetch` lane (openrouter,
 * kilocode). A plain credential-based GET, so it just polls on its own timer -
 * it never enters the `ephemeralProcess` serial queue.
 */
const HTTP_FETCH_RATE_LIMIT_REFETCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The method/params/options `useHostProviderRateLimitsQuery` builds its query
 * from - split out so a future host-scoped variant (e.g. tab-scoped) can
 * reuse the same shape without duplicating it.
 *
 * Branches on the fetch lane for background polling:
 * - `httpFetch` (openrouter, kilocode): its own `refetchInterval`, with
 *   `refetchIntervalInBackground: false` set explicitly (not left to the
 *   TanStack default) since these are now persistent app-shell subscriptions -
 *   no polling while the tab is hidden.
 * - `ephemeralProcess` (codex, claude-code): no `refetchInterval` at all. Their
 *   background refresh is driven entirely by the serial queue's interval timer
 *   writing fresh data into this exact query key; adding an interval here would
 *   spawn subprocesses outside the queue and defeat its concurrency bound.
 */
export function providerRateLimitQueryOptions(
  providerId: RateLimitProviderId,
): Omit<
  UseHostQueryOptions<HostRpcRegistry, "host.getRateLimitUsage">,
  "client"
> {
  const isHttpFetch = rateLimitFetchLane(providerId) === "httpFetch";
  return {
    method: "host.getRateLimitUsage",
    params: { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId },
    options: {
      retry: false,
      staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
      refetchInterval: isHttpFetch
        ? HTTP_FETCH_RATE_LIMIT_REFETCH_INTERVAL_MS
        : false,
      refetchIntervalInBackground: false,
    },
  };
}
