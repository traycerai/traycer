import { useCallback, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
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
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) return null;
  return (
    <ProviderRateLimitSettingsCard
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
    />
  );
}

/** The surrounding Profiles card owns the refresh action for embedded usage. */
export function EmbeddedProviderRateLimitForProvider({
  providerId,
  profileId,
  usageUpdatedAt,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) return null;
  return (
    <EmbeddedProviderRateLimitSettingsCard
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
    />
  );
}

/** Combined Profiles-header action: refresh auth/profile status and the
 * selected profile's usage limits from one control. */
export function ProviderProfilesRefreshButton({
  providerId,
  profileId,
  usageUpdatedAt,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) {
    return <ProfilesOnlyRefreshButton />;
  }
  return (
    <ProfilesAndUsageRefreshButton
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
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
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  const refreshProviders = useRefreshProviders();
  const query = useHostProviderRateLimitsQuery(providerId, profileId);
  const { refresh: refreshUsage, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId,
    usageUpdatedAt,
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
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(providerId, profileId);
  useRefreshProviderRateLimitsOnMount(providerId, profileId, usageUpdatedAt);
  useRefreshProviderRateLimitsOnTurn(providerId, profileId);

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
      <div className="text-ui-sm font-medium text-foreground">Usage limits</div>
      <ProviderRateLimitBody
        isPending={query.isPending}
        isFetching={query.isFetching}
        isError={query.isError}
        envelope={query.data}
      />
    </div>
  );
}

function ProviderRateLimitSettingsCard({
  providerId,
  profileId,
  usageUpdatedAt,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(providerId, profileId);
  const { refresh, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId,
    usageUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  useRefreshProviderRateLimitsOnTurn(providerId, profileId);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Usage limits
        </div>
        <RefreshIconButton
          onRefresh={refresh}
          label="Refresh usage limits"
          refreshing={isRefreshing}
        />
      </div>
      <ProviderRateLimitBody
        isPending={query.isPending}
        isFetching={query.isFetching || isRefreshing}
        isError={query.isError}
        envelope={query.data}
      />
    </div>
  );
}
