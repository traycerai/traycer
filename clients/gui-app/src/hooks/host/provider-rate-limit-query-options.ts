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
 * - `httpFetch` (openrouter, kilocode, huggingface, opencode): when credentials are
 *   fetch-eligible,
 *   opts in to the table's fixed cadence.
 *   The builder fixes its background setting to false, so persistent app-shell
 *   subscriptions do not poll while the window is hidden. `refetchOnMount` is
 *   disabled; the shared mount-refresh hook fetches only while no successful
 *   value exists, then the fixed cadence and manual refresh own freshness.
 * - `ephemeralProcess` (codex, claude-code, grok): the observer is disabled,
 *   never polls, and never refetches on mount. Every read of this key goes
 *   through `fetchProviderRateLimits` instead - the app-shell poll
 *   (`RateLimitPollProvider`), a surface's mount fetch
 *   (`useRefreshProviderRateLimitsOnMount`), a turn completion, a click -
 *   because only that function says whether the read is forced. An observer's
 *   own `queryFn` sends these params with no `force` at all, and an absent
 *   `force` reads on the wire as forced: every popover or Settings-card open
 *   would become a real CLI probe the host could otherwise have answered from
 *   its gauge.
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
      refetchOnMount: false,
    },
  };
}
