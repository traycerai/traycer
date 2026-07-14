import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
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
const HTTP_FETCH_RATE_LIMIT_REFETCH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The small, closed set of TanStack options every `host.getRateLimitUsage`
 * provider-pull consumer needs. Deliberately NOT expressed as (a slice of)
 * `UseQueryOptions<TData, ...>` - none of these six fields' types actually
 * depend on the cached data shape, and keeping this type TData-independent is
 * what lets the same `providerRateLimitQueryOptions` result compose with
 * every consumer regardless of which `TData` it reads (the raw wire response
 * for a plain `useHostQuery`, or the `ProviderRateLimitEnvelope` the
 * envelope-aware hooks in this ticket use) without a generic-variance fight.
 */
export interface ProviderRateLimitTanstackOptions {
  readonly enabled: boolean;
  readonly retry: false;
  readonly staleTime: number;
  readonly refetchInterval: number | false;
  readonly refetchIntervalInBackground: false;
  readonly refetchOnMount: boolean;
}

export interface ProviderRateLimitQueryOptions {
  readonly method: "host.getRateLimitUsage";
  readonly params: RequestOfMethod<HostRpcRegistry, "host.getRateLimitUsage">;
  readonly options: ProviderRateLimitTanstackOptions;
}

/**
 * The method/params/options every `host.getRateLimitUsage` provider-pull
 * consumer builds its query from - split out so a future host-scoped variant
 * (e.g. tab-scoped) can reuse the same shape without duplicating it.
 *
 * Branches on the fetch lane for background polling:
 * - `httpFetch` (openrouter, kilocode): its own `refetchInterval`, with
 *   `refetchIntervalInBackground: false` set explicitly (not left to the
 *   TanStack default) since these are now persistent app-shell subscriptions -
 *   no polling while the tab is hidden. `refetchOnMount` stays at TanStack's
 *   own default (`true`): a plain GET has no subprocess to bound, so letting a
 *   popover/Settings-card remount refetch directly when stale is exactly
 *   "fetch fresh data on open" with no downside.
 * - `ephemeralProcess` (codex, claude-code): no `refetchInterval` at all. Their
 *   background refresh is driven entirely by the serial queue's interval timer
 *   writing fresh data into this exact query key; adding an interval here would
 *   spawn subprocesses outside the queue and defeat its concurrency bound. For
 *   the exact same reason, `refetchOnMount` is forced to `false`: TanStack's
 *   default would otherwise fire a refetch straight through this query's own
 *   `queryFn` on every popover/Settings-card open (a fresh mount) whenever the
 *   cached data is stale - a direct host call that bypasses the queue and can
 *   overlap a fetch it's already draining. `useRefreshProviderRateLimitsOnMount`
 *   and `RateLimitQueueProvider` are the queue-routed replacements. The query
 *   observer is disabled for this lane so it observes the shared cache state
 *   without ever initiating its own subprocess-spawning request.
 */
export function providerRateLimitQueryOptions(
  providerId: RateLimitProviderId,
  profileId: string | null,
): ProviderRateLimitQueryOptions {
  const isHttpFetch = rateLimitFetchLane(providerId) === "httpFetch";
  return {
    method: "host.getRateLimitUsage",
    params: { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId, profileId },
    options: {
      enabled: isHttpFetch,
      retry: false,
      staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
      refetchInterval: isHttpFetch
        ? HTTP_FETCH_RATE_LIMIT_REFETCH_INTERVAL_MS
        : false,
      refetchIntervalInBackground: false,
      refetchOnMount: isHttpFetch ? true : false,
    },
  };
}
