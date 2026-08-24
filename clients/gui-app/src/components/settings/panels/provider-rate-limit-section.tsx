import { useCallback, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
import { isRateLimitQueryFailure } from "@/lib/rate-limits/rate-limit-read-status";
import { rateLimitFetchLane } from "@/lib/rate-limit-providers";
import { resolveCodexResetCreditAction } from "@/components/settings/panels/codex-reset-credit-availability";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";
import { useIsRateLimitReadFollowUpExhausted } from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";
import { useHostClient } from "@/lib/host";
import { useProvidersRefreshProfileStatusForClient } from "@/hooks/providers/use-providers-refresh-profile-status-mutation";
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
  onOpenModelProviders,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
  readonly onOpenModelProviders?: () => void;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) return null;
  return (
    <ProviderRateLimitSettingsCard
      providerId={providerId}
      profileId={profileId}
      usageUpdatedAt={usageUpdatedAt}
      fetchEligible={fetchEligible}
      onOpenModelProviders={onOpenModelProviders ?? null}
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
  maintenanceAvailable,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
  readonly maintenanceAvailable: boolean;
}): ReactNode {
  if (!maintenanceAvailable) {
    return isRateLimitCapableProvider(providerId) && fetchEligible ? (
      <ProfilesAndUsageRefreshButton
        providerId={providerId}
        profileId={profileId}
        usageUpdatedAt={usageUpdatedAt}
        fetchEligible={fetchEligible}
      />
    ) : (
      <ProfilesOnlyRefreshButton />
    );
  }
  return (
    <ProfileMaintenanceRefreshButton
      providerId={providerId}
      profileId={profileId}
    />
  );
}

function ProfileMaintenanceRefreshButton({
  providerId,
  profileId,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
}): ReactNode {
  const client = useHostClient();
  const refresh = useProvidersRefreshProfileStatusForClient(client);

  return (
    <RefreshIconButton
      onRefresh={async () => {
        await refresh.mutateAsync({
          providerId,
          profileId: profileId ?? "ambient",
        });
      }}
      label={
        isRateLimitCapableProvider(providerId)
          ? "Refresh profile status and usage limits"
          : "Refresh profile status"
      }
      refreshing={refresh.isPending}
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
    hasCachedValue: query.data !== undefined && query.data.lastGood !== null,
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
  useRefreshProviderRateLimitsOnMount({
    providerId,
    profileId,
    usageUpdatedAt,
    hasCachedValue: query.data !== undefined && query.data.lastGood !== null,
    fetchEligible,
    refetch: query.refetch,
  });
  useRefreshProviderRateLimitsOnTurn(providerId, profileId, fetchEligible);
  const followUpExhausted = useIsRateLimitReadFollowUpExhausted(
    providerId,
    profileId,
  );
  const presentedIsError = isRateLimitQueryFailure({
    isError: query.isError,
    error: query.error,
    queueOwned: rateLimitFetchLane(providerId) === "ephemeralProcess",
    followUpExhausted,
  });
  const recoveringUnheardRead = isRecoveringUnheardRead({
    isError: query.isError,
    presentedIsError,
  });

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
      <div className="text-ui-sm font-medium text-foreground">Usage limits</div>
      <ProviderRateLimitBody
        isPending={query.isPending}
        isFetching={query.isFetching || recoveringUnheardRead}
        isError={presentedIsError}
        envelope={query.data}
        codexResetAction={resolveCodexResetCreditAction(
          providerId,
          profileId,
          true,
        )}
        openModelProvidersAction={null}
      />
    </div>
  );
}

/**
 * Whether this read failed but is not being PRESENTED as a failure, because
 * the queue scheduled a delayed collection for it.
 *
 * Folded into the body's `isFetching` so the section reads as loading for that
 * window. Suppressing the error alone is not enough here: with no cached
 * envelope the view resolver would fall through to `empty` and render a blank
 * usage card until the collection landed.
 */
function isRecoveringUnheardRead(query: {
  readonly isError: boolean;
  readonly presentedIsError: boolean;
}): boolean {
  return query.isError && !query.presentedIsError;
}

function ProviderRateLimitSettingsCard({
  providerId,
  profileId,
  usageUpdatedAt,
  fetchEligible,
  onOpenModelProviders,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly fetchEligible: boolean;
  readonly onOpenModelProviders: (() => void) | null;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(
    providerId,
    profileId,
    fetchEligible,
  );
  // Single source of truth for this provider's refresh action + spinner state
  // (fresh-on-open, queue routing, and the ephemeralProcess `draining` fold-in),
  // shared verbatim with the popover's per-provider block.
  const { refresh, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId,
    usageUpdatedAt,
    hasCachedValue: query.data !== undefined && query.data.lastGood !== null,
    fetchEligible,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  useRefreshProviderRateLimitsOnTurn(providerId, profileId, fetchEligible);
  const followUpExhausted = useIsRateLimitReadFollowUpExhausted(
    providerId,
    profileId,
  );
  const presentedIsError = isRateLimitQueryFailure({
    isError: query.isError,
    error: query.error,
    queueOwned: rateLimitFetchLane(providerId) === "ephemeralProcess",
    followUpExhausted,
  });
  const recoveringUnheardRead = isRecoveringUnheardRead({
    isError: query.isError,
    presentedIsError,
  });

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
        isFetching={query.isFetching || isRefreshing || recoveringUnheardRead}
        isError={presentedIsError}
        envelope={query.data}
        codexResetAction={resolveCodexResetCreditAction(
          providerId,
          profileId,
          true,
        )}
        openModelProvidersAction={onOpenModelProviders}
      />
    </div>
  );
}
