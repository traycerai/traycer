import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

/**
 * TData-independent options shared by every `host.getRateLimitUsage` provider-pull consumer, so the same result composes with raw and envelope `TData`.
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
 * httpFetch opts into the table cadence with refetchOnMount false. ephemeralProcess disables the observer; refetchOnMount false so a mount cannot bypass the serial queue.
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
      // Invalidation marks them stale and refreshes when a lane is able to run; it must not also start a timer that blanks the last known reading merely because its observer is temporarily inactive.
      gcTime: Infinity,
      poll: isHttpFetch,
      retry: false,
      staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
      refetchOnMount: false,
    },
  };
}
