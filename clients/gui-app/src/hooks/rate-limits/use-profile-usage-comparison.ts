import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import type { HostRequestSpec } from "@/hooks/host/use-host-queries";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { useRunTargetHost } from "@/hooks/rate-limits/use-run-target-host";
import type { HostRpcRegistry } from "@/lib/host";
import {
  isRateLimitCapableProvider,
  isRateLimitProfileFetchEligible,
  rateLimitFetchLane,
  resolveRateLimitFetchEligibility,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  deriveProfileUsageDetailState,
  deriveProfileUsageRefreshStatus,
  type ProfileUsageComparisonEntry,
} from "@/lib/rate-limits/profile-usage-comparison-state";

export interface UseProfileUsageComparisonArgs {
  /** Never substitute the default host for an unreachable/non-ready tab host here; pass the real tab host id and let `isReady` reflect the unreachable state instead. */
  readonly runTargetHostId: string | null;
  readonly providerId: ProviderId;
  /** 2+ selectable profiles for `providerId` on the target host - the same set the profile dropdown renders. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

export interface ProfileUsageComparison {
  readonly hostId: string | null;
  readonly isReady: boolean;
  /** Keyed by `profileCommitId(profile)` - `null` for the ambient profile. */
  readonly entries: ReadonlyMap<string | null, ProfileUsageComparisonEntry>;
}

const EMPTY_RATE_LIMIT_REQUESTS: ReadonlyArray<
  HostRequestSpec<HostRpcRegistry, "host.getRateLimitUsage">
> = [];

/**
 * Cache-only (enabled false); mounting this hook never fetches. ephemeralProcess refresh uses target.queueScope, never the default-host queue.
 */
export function useProfileUsageComparison({
  runTargetHostId,
  providerId,
  profiles,
}: UseProfileUsageComparisonArgs): ProfileUsageComparison {
  const target = useRunTargetHost(runTargetHostId);
  const providersQuery = useProvidersListForClient(target.client, {
    enabled: target.isReady,
    subscribed: true,
  });
  const draining = useIsRateLimitQueueDraining();
  const rateLimitProviderId: RateLimitProviderId | null =
    isRateLimitCapableProvider(providerId) ? providerId : null;
  const lane =
    rateLimitProviderId === null
      ? null
      : rateLimitFetchLane(rateLimitProviderId);
  const fetchEligibility = useMemo(() => {
    const provider = providersQuery.data?.providers.find(
      (candidate) => candidate.providerId === providerId,
    );
    return provider === undefined
      ? null
      : resolveRateLimitFetchEligibility(provider);
  }, [providerId, providersQuery.data]);

  // Re-derived on a coarse interval (not read via `Date.now()` inline during render, which the render-purity rule forbids) so a long-open picker's fresh/stale classification keeps advancing rather than staying pinned to this hook's mount time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const requests = useMemo(() => {
    if (rateLimitProviderId === null) return EMPTY_RATE_LIMIT_REQUESTS;
    return profiles.map((profile) => {
      const { method, params } = providerRateLimitQueryOptions(
        rateLimitProviderId,
        profileCommitId(profile),
        false,
      );
      return { method, params };
    });
  }, [profiles, rateLimitProviderId]);

  const cacheQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client: target.client,
    cacheKeyIdentity: undefined,
    requests,
    options: PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  const entries = useMemo(() => {
    const map = new Map<string | null, ProfileUsageComparisonEntry>();
    profiles.forEach((profile, index) => {
      const profileId = profileCommitId(profile);
      const query =
        rateLimitProviderId === null ? undefined : cacheQueries[index];
      const detail = deriveProfileUsageDetailState(
        query?.data,
        {
          rateLimitStatus: profile.rateLimitStatus,
          usageUpdatedAt: profile.usageUpdatedAt,
        },
        query?.isError === true ? query.errorUpdatedAt : null,
        now,
      );
      const refreshStatus = deriveProfileUsageRefreshStatus({
        isFetchingThisProfile: query?.isFetching ?? false,
        queueDraining: draining,
        lane,
      });
      const fetchEligible =
        fetchEligibility !== null &&
        isRateLimitProfileFetchEligible(fetchEligibility, profile);
      const runFetch = async (force: boolean): Promise<void> => {
        if (rateLimitProviderId === null || lane === null || !fetchEligible) {
          return;
        }
        if (lane === "ephemeralProcess") {
          await enqueueRateLimitFetchForScope(
            target.queueScope,
            rateLimitProviderId,
            DEFAULT_ACCOUNT_CONTEXT,
            { force, profileId },
          );
          return;
        }
        if (query === undefined) return;
        await query.refetch();
      };
      const refresh = (): Promise<void> => runFetch(true);
      // Automatic callers only: the queue's `force: false` path skips still-fresh cache and honors the usage-fetch cool-down, so this can never re-trip a tripped server-side limit the way a forced refresh loop could.
      const ensureFresh = (): Promise<void> => runFetch(false);
      map.set(profileId, {
        profileId,
        providerId,
        detail,
        fetchEligible,
        refreshStatus,
        refresh,
        ensureFresh,
      });
    });
    return map;
  }, [
    cacheQueries,
    draining,
    fetchEligibility,
    lane,
    now,
    profiles,
    providerId,
    rateLimitProviderId,
    target.queueScope,
  ]);

  return { hostId: target.hostId, isReady: target.isReady, entries };
}
