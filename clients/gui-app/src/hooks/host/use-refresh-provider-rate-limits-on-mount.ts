import { useEffect } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";

/** Mount fetch goes through enqueueRateLimitFetch for ephemeralProcess; never queryFn (refetchOnMount is false). httpFetch refetches the observer. */
export interface ProviderRateLimitsMountRefreshInput {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly hasCachedValue: boolean;
  readonly fetchEligible: boolean;
  readonly refetch: (() => Promise<unknown>) | null;
}

export function useRefreshProviderRateLimitsOnMount({
  providerId,
  profileId,
  usageUpdatedAt,
  hasCachedValue,
  fetchEligible,
  refetch,
}: ProviderRateLimitsMountRefreshInput): void {
  const queueScope = useRateLimitQueueScope();
  useEffect(() => {
    if (!fetchEligible) return;
    const summaryFresh =
      usageUpdatedAt !== null &&
      Date.now() - usageUpdatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS;
    if (summaryFresh && hasCachedValue) return;
    if (rateLimitFetchLane(providerId) === "httpFetch") {
      if (refetch === null) return;
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
    fetchEligible,
    hasCachedValue,
    profileId,
    providerId,
    queueScope,
    refetch,
    usageUpdatedAt,
  ]);
}
