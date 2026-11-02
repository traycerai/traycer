import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { resolveCodexResetCreditAction } from "@/components/settings/panels/codex-reset-credit-availability";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";
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

/**
 * A live-fact card's heading: what it shows and the host that reported it.
 * A Personal page reads through the window's own host and offers no other, so
 * the heading carries no `Use another host`.
 */
function RateLimitsHeading(): ReactNode {
  const hostName = usePersonalHostName() ?? "this computer";
  return (
    <div className="text-ui-sm text-foreground">
      <span className="font-medium">Rate limits</span>
      <span className="text-muted-foreground">
        {" "}
        · as reported by {hostName}
      </span>
    </div>
  );
}

/** Rate limits for the profile the surrounding Profiles card has selected. */
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

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
      <RateLimitsHeading />
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
        openModelProvidersAction={null}
      />
    </div>
  );
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
  // (fresh-on-open, forced fetch for the ephemeral lane), shared verbatim with
  // the popover's per-provider block.
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

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <RateLimitsHeading />
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
        isFetching={query.isFetching}
        isError={query.isError}
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
