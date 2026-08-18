import { useEffect } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";

/**
 * On mount (and whenever the provider/profile, host scope, or fetch
 * eligibility changes), brings a surface's reading up to date when what the
 * renderer actually holds is missing or stale: "open the popover, see fresh
 * numbers" without re-probing a reading that is still fresh.
 *
 * The freshness judgement is made against the renderer's OWN query cache
 * (`dataUpdatedAt` of the surface's `host.getRateLimitUsage` observer) - never
 * against the host's per-profile `usageUpdatedAt` summary. That timestamp is
 * host-memory only, has no expiry, and advances even when a probe FAILS, so it
 * says nothing about whether this window has anything to show; gating on it
 * left rows with a real skeleton and a "stale" badge un-fetched indefinitely
 * (the #1222 regression). It stays a display concern for the row's label.
 *
 * - `ephemeralProcess` (codex, claude-code): enqueues a `force: false` pull on
 *   the shared serial queue. The queue owns the freshness floor
 *   (`PROVIDER_RATE_LIMITS_STALE_TIME_MS`) and the post-`usage_fetch_failed`
 *   cool-down, and re-checks both when the pull reaches the front of the lane,
 *   so this can never spawn a subprocess for a still-fresh reading or race one
 *   already queued or in flight. This is the queue-routed replacement for
 *   TanStack's own `refetchOnMount`, which `providerRateLimitQueryOptions`
 *   deliberately disables for this lane (a bare refetch would call the host
 *   directly, outside the queue).
 * - `httpFetch` (openrouter, kilocode, ...): a plain GET with no subprocess to
 *   serialize, so it refetches its own observer directly when the cached
 *   reading is absent or older than the same freshness floor. `refetch: null`
 *   (a surface with no observer handle) no-ops.
 *
 * `dataUpdatedAt` is an ordinary dependency: a reading that lands as a result
 * of this very effect re-runs it, but that re-run finds fresh data and no-ops
 * on both lanes (the queue's `force: false` floor, the staleness check here),
 * so it can never loop or spawn a second probe.
 */
export interface ProviderRateLimitsMountRefreshInput {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  /** The surface's own query `dataUpdatedAt` (`0` when nothing has ever landed). */
  readonly dataUpdatedAt: number;
  readonly fetchEligible: boolean;
  readonly refetch: (() => Promise<unknown>) | null;
}

export function useRefreshProviderRateLimitsOnMount({
  providerId,
  profileId,
  dataUpdatedAt,
  fetchEligible,
  refetch,
}: ProviderRateLimitsMountRefreshInput): void {
  const queueScope = useRateLimitQueueScope();
  useEffect(() => {
    if (!fetchEligible) return;
    if (rateLimitFetchLane(providerId) === "httpFetch") {
      if (refetch === null) return;
      const stale =
        Date.now() - dataUpdatedAt >= PROVIDER_RATE_LIMITS_STALE_TIME_MS;
      if (!stale) return;
      void refetch();
      return;
    }
    void enqueueRateLimitFetchForScope(
      queueScope,
      providerId,
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: false,
        profileId,
      },
    );
  }, [
    dataUpdatedAt,
    fetchEligible,
    profileId,
    providerId,
    queueScope,
    refetch,
  ]);
}
