/**
 * Settings > Providers rate-limit card for Codex / Claude Code: mirrors
 * `TraycerSubscriptionForProvider`'s gate shape in
 * `providers-settings-panel.tsx` (a tiny provider-id switch mounted inside
 * `ProviderDetail`), but for the two rate-limit-capable CLI providers
 * instead of `traycer`.
 */
import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  isRateLimitCapableProvider,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

// Gates the card the same way `TraycerSubscriptionForProvider` gates the
// subscription card: the rate-limit query never fires while viewing another
// provider, and `ProviderDetail` stays a flat mount list.
export function ProviderRateLimitForProvider({
  providerId,
}: {
  readonly providerId: ProviderId;
}): ReactNode {
  if (!isRateLimitCapableProvider(providerId)) return null;
  return <ProviderRateLimitSettingsCard providerId={providerId} />;
}

function ProviderRateLimitSettingsCard({
  providerId,
}: {
  readonly providerId: RateLimitProviderId;
}): ReactNode {
  const hostId = useReactiveActiveHostId();
  const query = useHostProviderRateLimitsQuery(providerId);
  // Keep the bars live: a turn on this provider finishing while the card is
  // open re-fetches usage. Only mounted here, so it costs nothing elsewhere.
  useRefreshProviderRateLimitsOnTurn(providerId, hostId);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Rate limits
        </div>
        <RefreshIconButton
          onRefresh={async () => {
            await query.refetch();
          }}
          label="Refresh rate limits"
          refreshing={query.isFetching}
        />
      </div>
      <ProviderRateLimitBody
        isPending={query.isPending}
        isFetching={query.isFetching}
        isError={query.isError}
        providerRateLimits={query.data?.providerRateLimits}
      />
    </div>
  );
}
