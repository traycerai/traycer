import { useCallback } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import {
  useIsRateLimitQueueTargetForced,
  useRateLimitQueueTargetPhase,
} from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";
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
 *   providers it is OR-ed with THIS target's own queue phase, so the control
 *   reflects a click from the moment it is enqueued rather than only once its
 *   `fetchQuery` starts behind an earlier item - without borrowing any other
 *   target's state.
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
  readonly hasCachedValue: boolean;
  readonly fetchEligible: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

export function useProviderRateLimitRefresh({
  providerId,
  profileId,
  usageUpdatedAt,
  hasCachedValue,
  fetchEligible,
  isFetching,
  refetch,
}: ProviderRateLimitRefreshInput): {
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
} {
  const targetPhase = useRateLimitQueueTargetPhase(providerId, profileId);
  const queueScope = useRateLimitQueueScope();
  const lane = rateLimitFetchLane(providerId);
  // Cold-start/recovery refresh for both lanes. Successful cached values leave
  // freshness to the interval timer and manual refresh action.
  useRefreshProviderRateLimitsOnMount({
    providerId,
    profileId,
    usageUpdatedAt,
    hasCachedValue,
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

  // Scoped to THIS provider/profile's own queue entry, never the lane-wide
  // draining flag, and only while that entry is actually FETCHING.
  //
  // `RefreshIconButton` DISABLES on this value and its trigger no-ops while
  // set. Two consequences drive both halves of this rule. Gating on the whole
  // lane turned every ephemeral control off whenever anything was queued
  // anywhere (a background sweep of an unrelated provider, one wedged probe
  // holding the lane for its full response budget). And counting `"queued"`
  // here would disable the control in precisely the state where a click still
  // does real work: an enqueue for an already-queued target promotes it
  // (`pending.force = true`), which is the only thing that stops that pull
  // being skipped by its second freshness/cool-down check or reaching the host
  // as `force: false` and being served from the gauge cache.
  //
  // So the two QUEUED states split, rather than the phase alone deciding:
  //
  //   queued + not yet forced -> stays clickable; the click promotes it.
  //   queued + already forced -> nothing left to promote, so read as pending.
  //
  // Without that second arm a user who clicks while another target holds the
  // lane gets a control that falls idle and clickable again the moment
  // `RefreshIconButton`'s 10s internal cap lapses, with their request still
  // pending for up to the full response budget. The popover row renders
  // #1268's "Queued…" label, but the Settings consumers do not - so for them
  // the spinner is the ONLY feedback that exists.
  const targetForced = useIsRateLimitQueueTargetForced(providerId, profileId);
  const isRefreshing =
    fetchEligible &&
    (isFetching ||
      (lane === "ephemeralProcess" &&
        (targetPhase === "fetching" ||
          (targetPhase === "queued" && targetForced))));

  return { refresh, isRefreshing };
}
