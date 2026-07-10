/**
 * Settings > Providers rate-limit card for Codex / Claude Code: mirrors
 * `TraycerSubscriptionForProvider`'s gate shape in
 * `providers-settings-panel.tsx` (a tiny provider-id switch mounted inside
 * `ProviderDetail`), but for the two rate-limit-capable CLI providers
 * instead of `traycer`.
 *
 * `profileId`/`usageUpdatedAt` scope the card to one profile's data (multi-
 * profile UX overhaul, T10): `ProviderDetail` passes `null`/`null` for a
 * provider reporting zero profiles (unscoped, byte-identical to before this
 * ticket); `ProviderProfileScopedSection` passes the section's selected
 * profile's commit id + its own `usageUpdatedAt`. Turn-completion live
 * auto-refresh (`useRefreshProviderRateLimitsOnTurn`) stays harness-scoped,
 * not profile-scoped - `ChatTurnCompletion` carries no `profileId` today, so
 * threading it through would mean extending the chat-session notification
 * subsystem, out of scope here. The manual refresh button and the query
 * itself are fully profile-scoped regardless.
 */
import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";
import {
  isRateLimitCapableProvider,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

// Gates the card the same way `TraycerSubscriptionForProvider` gates the
// subscription card: the rate-limit query never fires while viewing another
// provider, and `ProviderDetail` stays a flat mount list.
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

function ProviderRateLimitSettingsCard({
  providerId,
  profileId,
  usageUpdatedAt,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
}): ReactNode {
  const hostId = useReactiveActiveHostId();
  const query = useHostProviderRateLimitsQuery(providerId, profileId);
  // Single source of truth for this provider's refresh action + spinner state
  // (fresh-on-open, queue routing, and the ephemeralProcess `draining` fold-in),
  // shared verbatim with the popover's per-provider block.
  const { refresh, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId,
    usageUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  // Keep the bars live: a turn on this provider finishing while the card is
  // open re-fetches usage. Only mounted here, so it costs nothing elsewhere.
  useRefreshProviderRateLimitsOnTurn(providerId, hostId);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Usage limits
        </div>
        <RefreshIconButton
          onRefresh={refresh}
          label="Refresh usage limits"
          // `isRefreshing` (from useProviderRateLimitRefresh) already folds in
          // the ephemeralProcess `draining` flag, so this stays disabled for a
          // "Refresh all" round's full duration, not just this provider's slice.
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
