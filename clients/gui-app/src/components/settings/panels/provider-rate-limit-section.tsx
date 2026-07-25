import { useCallback, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
import { resolveCodexResetCreditAction } from "@/components/settings/panels/codex-reset-credit-availability";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";
import { useRefreshProviders } from "@/hooks/providers/use-refresh-providers";
import {
  isRateLimitCapableProvider,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

export function ProviderRateLimitForProvider({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) return null;
  return (
    <ProviderRateLimitSettingsCard
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
      fetchEligible={fetchEligible}
    />
  );
}

/** The surrounding Profiles card owns the refresh action for embedded usage. */
export function EmbeddedProviderRateLimitForProvider({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) return null;
  return (
    <EmbeddedProviderRateLimitSettingsCard
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
      fetchEligible={fetchEligible}
    />
  );
}

/** Combined Profiles-header action: refresh auth/profile status and the
 * selected profile's usage limits from one control. */
export function ProviderProfilesRefreshButton({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId) || !fetchEligible) {
    return <ProfilesOnlyRefreshButton />;
  }
  return (
    <ProfilesAndUsageRefreshButton
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
      fetchEligible={fetchEligible}
    />
  );
}

function ProfilesOnlyRefreshButton(): ReactNode {
  const refreshProviders = useRefreshProviders();
  return (
    <RefreshIconButton
      onRefresh={refreshProviders}
      label="Refresh profile statuses"
    />
  );
}

function ProfilesAndUsageRefreshButton({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
}): ReactNode {
  const refreshProviders = useRefreshProviders();
  const query = useHostProviderRateLimitsQuery(
    providerId,
    profileId,
    fetchEligible,
  );
  const { refresh: refreshUsage, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId,
    usageUpdatedAt,
    fetchEligible,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshProviders(), refreshUsage()]);
  }, [refreshProviders, refreshUsage]);

  return (
    <RefreshIconButton
      onRefresh={refresh}
      label="Refresh profile statuses and usage limits"
      refreshing={isRefreshing}
    />
  );
}

function EmbeddedProviderRateLimitSettingsCard({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(
    providerId,
    profileId,
    fetchEligible,
  );
  useRefreshProviderRateLimitsOnMount(
    providerId,
    profileId,
    usageUpdatedAt,
    fetchEligible,
  );
  useRefreshProviderRateLimitsOnTurn(providerId, profileId, fetchEligible);

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
      <div className="text-ui-sm font-medium text-foreground">Usage limits</div>
      <ProviderRateLimitBody
        isPending={query.isPending}
        isFetching={query.isFetching}
        isError={query.isError}
        envelope={query.data}
        codexResetAction={resolveCodexResetCreditAction(
          providerId,
          profileId,
          true,
        )}
      />
    </div>
  );
}

function ProviderRateLimitSettingsCard({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(
    providerId,
    profileId,
    fetchEligible,
  );
  const { refresh, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId,
    usageUpdatedAt,
    fetchEligible,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  useRefreshProviderRateLimitsOnTurn(providerId, profileId, fetchEligible);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Usage limits
        </div>
        {fetchEligible ? (
          <RefreshIconButton
            onRefresh={refresh}
            label="Refresh usage limits"
            refreshing={isRefreshing}
          />
        ) : null}
      </div>
      <ProviderRateLimitBody
        isPending={query.isPending}
        isFetching={query.isFetching || isRefreshing}
        isError={query.isError}
        envelope={query.data}
        codexResetAction={resolveCodexResetCreditAction(
          providerId,
          profileId,
          true,
        )}
      />
    </div>
  );
}
