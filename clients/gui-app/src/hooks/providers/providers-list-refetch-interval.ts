import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

export const PROVIDERS_LIST_REFRESH_MS = 15 * 60 * 1000;
export const PROVIDERS_LIST_PENDING_REFRESH_MS = 800;

/**
 * Bounded-staleness cadence while any profile is reporting near/hard limit -
 * short enough that the rate-limit switch-prompt banner (which reads
 * `providers.list`) self-clears within half a minute of the provider's window
 * actually resetting (Part A's reset-aware gauge derivation on the host now
 * reports that reset instead of a stale-forever limit), even with the app
 * otherwise idle and no turn/fetch around to trigger a convergence
 * invalidation.
 */
export const PROVIDERS_LIST_LIMITED_REFRESH_MS = 30 * 1000;

type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

function hasPendingProbe(data: ProvidersListResponse | undefined): boolean {
  return (
    data?.providers.some(
      (provider) =>
        provider.authPending ||
        provider.availabilityPending ||
        provider.candidates.some((candidate) => candidate.versionPending),
    ) ?? false
  );
}

function hasLimitedProfile(data: ProvidersListResponse | undefined): boolean {
  return (
    data?.providers.some((provider) =>
      provider.profiles.some(
        (profile) =>
          profile.rateLimitStatus === "near_limit" ||
          profile.rateLimitStatus === "hard_limit",
      ),
    ) ?? false
  );
}

/**
 * Shared `providers.list` `refetchInterval` for both the default-host
 * (`useProvidersList`) and tab-host-scoped (`useTabProvidersList`) consumers:
 * fastest while any probe is still pending (auth/availability/version),
 * bounded while any profile is near/at its rate limit, otherwise the steady
 * catalog cadence.
 */
export function providersListRefetchInterval(
  data: ProvidersListResponse | undefined,
): number {
  if (hasPendingProbe(data)) return PROVIDERS_LIST_PENDING_REFRESH_MS;
  if (hasLimitedProfile(data)) return PROVIDERS_LIST_LIMITED_REFRESH_MS;
  return PROVIDERS_LIST_REFRESH_MS;
}
