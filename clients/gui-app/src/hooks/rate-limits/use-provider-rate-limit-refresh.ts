import { useCallback } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

/**
 * The single source of truth for "how do I refresh one provider's rate limits,
 * and is that provider currently refreshing" - shared verbatim by the popover's
 * per-provider block and the Settings card so their refresh button can never
 * drift apart again. Both the action and the spinner state are lane-aware:
 *
 * - **Action (`refresh`)**:
 *   - `ephemeralProcess` (codex, claude-code): routes through the shared serial
 *     queue with `force: true`, so a manual refresh can never spawn a CLI
 *     subprocess overlapping one the queue is already running. A bare
 *     `query.refetch()` here would call the host directly and bypass that bound.
 *   - `httpFetch` (openrouter, kilocode): a plain GET with no subprocess to
 *     serialize, so it just refetches its own query.
 *
 * - **Spinner state (`isRefreshing`)**: `query.isFetching` covers a fetch on
 *   THIS provider's own query key (whoever triggered it - the queue's
 *   `fetchQuery`, a direct refetch, an invalidation). For `ephemeralProcess`
 *   providers it is OR-ed with the queue's `draining` flag, because the queue
 *   runs providers one at a time: this provider's own `isFetching` can settle
 *   the instant its turn finishes while "Refresh all" is still working through a
 *   later provider queued behind it. Gating on `draining` (the whole round)
 *   rather than only this provider's own fetch keeps the button disabled for as
 *   long as any refresh in the shared lane is in flight - matching the user's
 *   "Refresh all is in progress" mental model, not "my own fetch is in flight".
 *   `httpFetch` providers refresh concurrently (no shared queue), so their own
 *   `isFetching` is already the complete signal.
 *
 * `isFetching` / `refetch` are threaded in from the caller's existing
 * `useHostProviderRateLimitsQuery` observer rather than opening a second one
 * here, so there is still exactly one query observer per mounted block.
 */
export interface ProviderRateLimitRefreshInput {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

export function useProviderRateLimitRefresh({
  providerId,
  profileId,
  usageUpdatedAt,
  isFetching,
  refetch,
}: ProviderRateLimitRefreshInput): {
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
} {
  const draining = useIsRateLimitQueueDraining();
  const queueScope = useRateLimitQueueScope();
  const lane = rateLimitFetchLane(providerId);
  // Fresh-data-on-open for the ephemeralProcess lane, routed through the shared
  // serial queue rather than TanStack's own (deliberately disabled)
  // refetch-on-mount - see providerRateLimitQueryOptions' doc comment. No-ops
  // for the httpFetch lane, which keeps TanStack's refetch-on-mount instead.
  useRefreshProviderRateLimitsOnMount(providerId, profileId, usageUpdatedAt);

  const refresh = useCallback(async (): Promise<void> => {
    if (lane === "ephemeralProcess") {
      await enqueueRateLimitFetchForScope(
        queueScope,
        providerId,
        DEFAULT_ACCOUNT_CONTEXT,
        {
          force: true,
          profileId,
        },
      );
      return;
    }
    await refetch();
  }, [lane, profileId, providerId, queueScope, refetch]);

  const isRefreshing = isFetching || (lane === "ephemeralProcess" && draining);

  return { refresh, isRefreshing };
}
