import { useCallback } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { useIsRateLimitFetchPending } from "@/hooks/rate-limits/use-is-rate-limit-fetch-pending";
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
 *   providers it is OR-ed with THIS profile's own queue-pending flag, so the
 *   control reflects a click (or a sweep covering it) from the moment it is
 *   enqueued rather than only once its own `fetchQuery` starts behind an
 *   earlier item - and stays on for the whole "Refresh all" batch it belongs
 *   to, since a batch's pending keys clear together when the item settles.
 *
 *   It is deliberately NOT the lane-wide `draining` flag. `RefreshIconButton`
 *   DISABLES on this value and its trigger no-ops while set, and the external
 *   half has no timeout cap - so gating on the whole lane meant any queued work
 *   anywhere (a background sweep of an unrelated provider, one wedged probe
 *   holding the lane for its full response budget) turned every rate-limit
 *   refresh control off. That also made the queue's priority scheduling
 *   unreachable from the UI: a forced item jumps ahead of waiting automatic
 *   ones, but the click that would enqueue it was blocked in exactly the state
 *   where jumping matters.
 *
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
  /** The caller's own query `dataUpdatedAt` (`0` when nothing has landed yet). */
  readonly dataUpdatedAt: number;
  readonly fetchEligible: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

export function useProviderRateLimitRefresh({
  providerId,
  profileId,
  dataUpdatedAt,
  fetchEligible,
  isFetching,
  refetch,
}: ProviderRateLimitRefreshInput): {
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
} {
  const queuePending = useIsRateLimitFetchPending(providerId, profileId);
  const queueScope = useRateLimitQueueScope();
  const lane = rateLimitFetchLane(providerId);
  // Fresh-data-on-open for both lanes, judged against this surface's own
  // cached reading (missing or older than the freshness floor); a still-fresh
  // reading is left to the interval timer and the manual refresh action.
  useRefreshProviderRateLimitsOnMount({
    providerId,
    profileId,
    dataUpdatedAt,
    fetchEligible,
    refetch,
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!fetchEligible) return;
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
  }, [fetchEligible, lane, profileId, providerId, queueScope, refetch]);

  const isRefreshing =
    fetchEligible &&
    (isFetching || (lane === "ephemeralProcess" && queuePending));

  return { refresh, isRefreshing };
}
