import { useMemo } from "react";
import type {
  ProviderId,
  ProviderAuthStatus,
  ProvidersListResponse,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { type ProviderRateLimitTanstackOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import {
  isRateLimitCapableProvider,
  isRateLimitProfileFetchEligible,
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  resolveRateLimitFetchEligibility,
  type RateLimitFetchEligibility,
  type RateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
export interface ConfiguredRateLimitProvider {
  readonly providerId: RateLimitProviderId;
  readonly lane: RateLimitFetchLane;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  /** Target-scoped credential eligibility, independent from display/cache state. */
  readonly fetchEligibility: RateLimitFetchEligibility;
}

/** Display facts belong to the usage inventory, not the polling targets. */
export interface MappedVisibleRateLimitProvider extends ConfiguredRateLimitProvider {
  readonly authStatus: ProviderAuthStatus;
  readonly usageReportingConfirmed: boolean;
}

/** An adapter may report usage before this client has a fetch arm for it. */
export type VisibleRateLimitProvider =
  | MappedVisibleRateLimitProvider
  | {
      readonly providerId: Exclude<ProviderId, RateLimitProviderId>;
      readonly lane: null;
      readonly authStatus: ProviderAuthStatus;
      readonly usageReportingConfirmed: boolean;
      readonly profiles: ReadonlyArray<ProviderProfile>;
      readonly fetchEligibility: RateLimitFetchEligibility;
    };

/**
 * Cache-only observation: never `enabled`, so mounting this options object
 * against a query never initiates its own provider read - it only reflects
 * whatever `fetchProviderRateLimits` or another lane's active query already
 * wrote into that exact cache key. Exported for other picker-only surfaces
 * (`use-profile-usage-comparison.ts`) that need the same "observe, never
 * fetch" contract.
 */
export const PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS: ProviderRateLimitTanstackOptions =
  {
    enabled: false,
    gcTime: Infinity,
    poll: false,
    retry: false,
    staleTime: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    refetchOnMount: false,
  };

/** True when at least one ambient or managed target can safely pull usage. */
function hasEligibleFetchTarget(
  provider: ConfiguredRateLimitProvider,
): boolean {
  return (
    provider.fetchEligibility.ambient ||
    provider.profiles.some((profile) =>
      isRateLimitProfileFetchEligible(provider.fetchEligibility, profile),
    )
  );
}

function rateLimitProviderCandidate(
  state: ProvidersListResponse["providers"][number],
): VisibleRateLimitProvider {
  const common = {
    authStatus: state.auth.status,
    usageReportingConfirmed: state.usageReporting !== undefined,
    profiles: state.profiles,
    fetchEligibility: resolveRateLimitFetchEligibility(state),
  };
  const providerId = state.providerId;
  // The enum chooses the fetch arm; old-host membership is handled below.
  return isRateLimitCapableProvider(providerId)
    ? { ...common, providerId, lane: rateLimitFetchLane(providerId) }
    : { ...common, providerId, lane: null };
}

function rateLimitProviderCandidates(
  providers: ProvidersListResponse["providers"],
): ReadonlyArray<VisibleRateLimitProvider> {
  return providers
    .filter(
      (state) =>
        state.enabled &&
        (state.usageReporting ?? isRateLimitCapableProvider(state.providerId)),
    )
    .map(rateLimitProviderCandidate);
}

/** Fetch consumers carry account identity and eligibility, not display metadata. */
function configuredRateLimitProvider(
  provider: MappedVisibleRateLimitProvider,
): ConfiguredRateLimitProvider {
  return {
    providerId: provider.providerId,
    lane: provider.lane,
    profiles: provider.profiles,
    fetchEligibility: provider.fetchEligibility,
  };
}

/** Adapter-reporting providers with a mapped, eligible usage fetch target. */
export function useConfiguredRateLimitProviders(): ReadonlyArray<ConfiguredRateLimitProvider> {
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  return useMemo(() => {
    if (providers === undefined) return [];
    return rateLimitProviderCandidates(providers).flatMap((provider) =>
      provider.lane !== null && hasEligibleFetchTarget(provider)
        ? [configuredRateLimitProvider(provider)]
        : [],
    );
  }, [providers]);
}

/** What a host says it has, and whether it has said anything at all. */
export interface RateLimitAccountInventory {
  /**
   * Whether the host has ANSWERED, as opposed to not having said anything (a
   * cold query, a refetch with nothing cached, no host to ask). Both read as
   * an empty list, and a caller that ends something when an account stops
   * being listed has to tell them apart: an answer of "none" is the host
   * reporting that every account is gone, while silence is no report at all.
   */
  readonly answered: boolean;
  /** Mapped accounts before capability, fetch eligibility or usage observations.
   * Capability changes cannot retire account-scoped retry episodes. */
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
}

/**
 * The host's own account inventory, for a caller whose question is which
 * accounts EXIST. A passive observer (`enabled: false`, `subscribed: false`)
 * of the same `providers.list` key the app shell already keeps subscribed on
 * this host, so it reads the answer without asking for one.
 */
export function useRateLimitAccountInventory(): RateLimitAccountInventory {
  const providersQuery = useProvidersList({
    enabled: false,
    subscribed: false,
  });
  const providers = providersQuery.data?.providers;
  return useMemo(
    () => ({
      answered: providers !== undefined,
      providers:
        providers === undefined
          ? []
          : providers
              .filter((state) => state.enabled)
              .map(rateLimitProviderCandidate)
              .filter(
                (provider): provider is MappedVisibleRateLimitProvider =>
                  provider.lane !== null,
              )
              .map(configuredRateLimitProvider),
    }),
    [providers],
  );
}

/**
 * One providers.list inventory, filtered only by enablement and the adapter's
 * usage capability. Older hosts omit it, so their fetch-arm enum is the
 * compatibility fallback and the row is marked unconfirmed. Reachability,
 * auth and usage observations belong to rows;
 * they never decide whether a provider or its sibling accounts exist.
 */
export function useVisibleRateLimitProviders(): ReadonlyArray<VisibleRateLimitProvider> {
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  return useMemo(
    () =>
      providers === undefined ? [] : rateLimitProviderCandidates(providers),
    [providers],
  );
}
