import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

/**
 * The small, closed set of TanStack options every `host.getRateLimitUsage`
 * provider-pull consumer needs. Deliberately NOT expressed as (a slice of)
 * `UseQueryOptions<TData, ...>` - none of these fields' types actually
 * depend on the cached data shape, and keeping this type TData-independent is
 * what lets the same `providerRateLimitQueryOptions` result compose with
 * every consumer regardless of which `TData` it reads (the raw wire response
 * for a plain `useHostQuery`, or the `ProviderRateLimitEnvelope` the
 * envelope-aware hooks in this ticket use) without a generic-variance fight.
 */
export interface ProviderRateLimitTanstackOptions {
  readonly enabled: boolean;
  readonly gcTime: number;
  readonly poll: boolean;
  readonly retry: false;
  readonly staleTime: number;
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
 * - `httpFetch` (openrouter, kilocode): when credentials are fetch-eligible,
 *   opts in to the table's fixed cadence.
 *   The builder fixes its background setting to false, so persistent app-shell
 *   subscriptions do not poll while the window is hidden. `refetchOnMount`
 *   stays at TanStack's own default (`true`): a plain GET has no subprocess to
 *   bound, so letting a popover/Settings-card remount refetch directly when
 *   stale is exactly "fetch fresh data on open" with no downside.
 * - `ephemeralProcess` (codex, claude-code): opts out of observer polling. Its
 *   background refresh is driven entirely by the serial queue's interval timer
 *   writing fresh data into this exact query key. For the exact same reason,
 *   `refetchOnMount` is forced to `false`: TanStack's
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
  fetchEligible: boolean,
): ProviderRateLimitQueryOptions {
  const isHttpFetch =
    rateLimitFetchLane(providerId) === "httpFetch" && fetchEligible;
  return {
    method: "host.getRateLimitUsage",
    params: { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId, profileId },
    options: {
      enabled: isHttpFetch,
      // Rate-limit readings are last-known state, not disposable request
      // results. Invalidation marks them stale and refreshes when a lane is
      // able to run; it must not also start a timer that blanks the last known
      // reading merely because its observer is temporarily inactive. A fresh
      // authoritative unavailable response still replaces retained data in
      // `buildProviderRateLimitEnvelope`.
      gcTime: Infinity,
      poll: isHttpFetch,
      retry: false,
      staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
      refetchOnMount: isHttpFetch ? true : false,
    },
  };
}
