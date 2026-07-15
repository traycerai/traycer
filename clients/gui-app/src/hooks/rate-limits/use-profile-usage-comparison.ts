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
import { PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { useRunTargetHost } from "@/hooks/rate-limits/use-run-target-host";
import type { HostRpcRegistry } from "@/lib/host";
import {
  isRateLimitCapableProvider,
  rateLimitFetchLane,
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
  /** The host that will execute the next run - a tab's lifetime-bound host
   *  id, or `null` for the app-wide default host. Never substitute the
   *  default host for an unreachable/non-ready tab host here; pass the real
   *  tab host id and let `isReady` reflect the unreachable state instead. */
  readonly runTargetHostId: string | null;
  readonly providerId: ProviderId;
  /** 2+ selectable profiles for `providerId` on the target host - the same
   *  set the profile dropdown renders. Every profile gets a comparison
   *  entry; only rate-limit-capable providers (`isRateLimitCapableProvider`)
   *  mount cache observers, so a non-capable provider's profiles all resolve
   *  from their host summary alone (`never-checked`/`semantic-only`). */
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
 * Combines a target host's cache-only rate-limit envelopes with each
 * profile's cheap host summary (`rateLimitStatus`, `usageUpdatedAt`) into
 * the stable per-profile comparison-state contract T3 renders, and exposes
 * one explicit refresh per profile.
 *
 * Cache-only observation: every envelope query mounts with
 * `PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS` (`enabled: false`), so calling this
 * hook - on picker mount, profile-menu open, hover, focus, or row change -
 * never itself initiates a `host.getRateLimitUsage` request. It only
 * reflects whatever another actor (the shared serial queue, an explicit
 * refresh from this same hook, or another mounted observer of the same host)
 * has already written into that exact `(host, provider, profile)` cache key.
 *
 * Explicit refresh addresses exactly one `(host, provider, profile)`: the
 * `ephemeralProcess` lane (codex, claude-code) routes through the shared
 * serial queue via `target.queueScope` (never the default-host-bound
 * `useRateLimitQueueScope`), so a refresh from a tab-scoped picker still
 * serializes against every other host's subprocess work; the `httpFetch`
 * lane (openrouter, kilocode) refetches this profile's own passive query
 * directly - no shared queue to route through, preserving that lane's
 * existing concurrent-refresh behavior. Refresh is independent of profile
 * selection and picker/menu open state - each entry's `refresh` is a plain
 * function a caller invokes for whichever profile it is previewing.
 */
export function useProfileUsageComparison({
  runTargetHostId,
  providerId,
  profiles,
}: UseProfileUsageComparisonArgs): ProfileUsageComparison {
  const target = useRunTargetHost(runTargetHostId);
  const draining = useIsRateLimitQueueDraining();
  const rateLimitProviderId: RateLimitProviderId | null =
    isRateLimitCapableProvider(providerId) ? providerId : null;
  const lane =
    rateLimitProviderId === null
      ? null
      : rateLimitFetchLane(rateLimitProviderId);

  // Re-derived on a coarse interval (not read via `Date.now()` inline during
  // render, which the render-purity rule forbids) so a long-open picker's
  // fresh/stale classification keeps advancing rather than staying pinned to
  // this hook's mount time. Mirrors `useTrayEpicsSource`'s `nowMs` pattern.
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
      const refresh = async (): Promise<void> => {
        if (rateLimitProviderId === null || lane === null) return;
        if (lane === "ephemeralProcess") {
          await enqueueRateLimitFetchForScope(
            target.queueScope,
            rateLimitProviderId,
            DEFAULT_ACCOUNT_CONTEXT,
            { force: true, profileId },
          );
          return;
        }
        if (query === undefined) return;
        await query.refetch();
      };
      map.set(profileId, {
        profileId,
        providerId,
        detail,
        refreshStatus,
        refresh,
      });
    });
    return map;
  }, [
    cacheQueries,
    draining,
    lane,
    now,
    profiles,
    providerId,
    rateLimitProviderId,
    target.queueScope,
  ]);

  return { hostId: target.hostId, isReady: target.isReady, entries };
}
