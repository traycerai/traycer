/**
 * Settings > Providers rate-limit card for Codex / Claude Code: mirrors
 * `TraycerSubscriptionForProvider`'s gate shape in
 * `providers-settings-panel.tsx` (a tiny provider-id switch mounted inside
 * `ProviderDetail`), but for the two rate-limit-capable CLI providers
 * instead of `traycer`.
 */
import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ProviderRateLimitBody } from "@/components/settings/panels/provider-rate-limit-views";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { enqueueRateLimitFetch } from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  isRateLimitCapableProvider,
  rateLimitFetchLane,
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
  // Fresh-data-on-open for the ephemeralProcess lane, routed through the
  // shared serial queue rather than TanStack's own (deliberately disabled)
  // refetch-on-mount - see providerRateLimitQueryOptions' doc comment.
  useRefreshProviderRateLimitsOnMount(providerId);
  // Keep the bars live: a turn on this provider finishing while the card is
  // open re-fetches usage. Only mounted here, so it costs nothing elsewhere.
  useRefreshProviderRateLimitsOnTurn(providerId, hostId);
  const draining = useIsRateLimitQueueDraining();
  const lane = rateLimitFetchLane(providerId);

  // Same split the popover's `RateLimitProviderBlock` uses: an ephemeralProcess
  // manual refresh must go through the serial queue (`force: true`) so it can't
  // spawn a subprocess overlapping one the queue is already running - a bare
  // `query.refetch()` here would call the host directly, bypassing that bound.
  const refresh = async (): Promise<void> => {
    if (lane === "ephemeralProcess") {
      await enqueueRateLimitFetch(providerId, DEFAULT_ACCOUNT_CONTEXT, {
        force: true,
      });
      return;
    }
    await query.refetch();
  };

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Rate limits
        </div>
        <RefreshIconButton
          onRefresh={refresh}
          label="Refresh rate limits"
          // See the popover's identical comment: an ephemeralProcess
          // provider's own `isFetching` can settle before the shared queue's
          // round does (another provider queued behind it is still running),
          // so fold in `draining` to keep this disabled for the whole round.
          refreshing={
            query.isFetching || (lane === "ephemeralProcess" && draining)
          }
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
