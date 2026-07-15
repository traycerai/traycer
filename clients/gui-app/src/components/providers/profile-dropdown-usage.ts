import type { ProfileUsageProjection } from "@/lib/rate-limits/profile-usage-projection";
import { projectProfileUsage } from "@/lib/rate-limits/profile-usage-projection";
import type {
  ProfileUsageComparisonEntry,
  ProfileUsageDetailState,
  ProfileUsageRefreshStatus,
} from "@/lib/rate-limits/profile-usage-comparison-state";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";

export interface ProfileDropdownUsageEntry {
  readonly profileId: string | null;
  readonly projection: ProfileUsageProjection;
  readonly refreshStatus: ProfileUsageRefreshStatus;
  readonly refresh: () => Promise<void>;
}

export interface ProfileDropdownUsagePresentation {
  readonly isHostReady: boolean;
  readonly entries: ReadonlyMap<string | null, ProfileDropdownUsageEntry>;
}

/**
 * The comparison hook observes a process-wide queue, so its `queued` state is
 * only evidence that some ephemeral refresh is waiting. The picker adds the
 * local interaction fact that this specific profile initiated a refresh before
 * exposing that state to the sidecar.
 */
export function scopeProfileUsageRefreshStatus(
  observedStatus: ProfileUsageRefreshStatus,
  refreshPending: boolean,
): ProfileUsageRefreshStatus {
  if (observedStatus === "refreshing") return "refreshing";
  return refreshPending ? "queued" : "idle";
}

function envelopeFromDetail(
  detail: ProfileUsageDetailState,
): ProviderRateLimitEnvelope | null {
  switch (detail.kind) {
    case "fresh":
    case "stale":
      return {
        latest: detail.usage,
        lastGood: detail.usage,
        lastGoodAt: detail.asOf,
        lastFailureAt: null,
      };
    case "failed-with-last-good":
      return {
        latest: detail.usage,
        lastGood: detail.usage,
        lastGoodAt: detail.asOf,
        lastFailureAt: detail.failedAt,
      };
    case "unavailable":
      return {
        latest: detail.usage,
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: null,
      };
    case "never-checked":
    case "semantic-only":
    case "failed-no-last-good":
      return null;
  }
}

/**
 * Adapts T2's cache/refresh state to T1's canonical picker projection. The
 * adapter deliberately carries no independent percentage or severity rules:
 * live-window selection, most-constrained choice, and semantic classification
 * all remain owned by `projectProfileUsage`.
 */
export function projectComparisonEntry(
  entry: ProfileUsageComparisonEntry,
  now: number,
): ProfileDropdownUsageEntry {
  const detail = entry.detail;
  const semanticStatus =
    detail.kind === "semantic-only" ? detail.status : "unknown";
  const usageUpdatedAt =
    detail.kind === "fresh" ||
    detail.kind === "stale" ||
    detail.kind === "failed-with-last-good"
      ? detail.asOf
      : null;
  const detailError =
    detail.kind === "failed-with-last-good" ||
    detail.kind === "failed-no-last-good";

  return {
    profileId: entry.profileId,
    projection: projectProfileUsage({
      rateLimitStatus: semanticStatus,
      usageUpdatedAt,
      envelope: envelopeFromDetail(detail),
      detailError,
      now,
      staleAfterMs: PROVIDER_RATE_LIMITS_STALE_TIME_MS,
    }),
    refreshStatus: entry.refreshStatus,
    refresh: entry.refresh,
  };
}

export function profileUsageAccessibleStatus(
  projection: ProfileUsageProjection,
): "Healthy" | "Running low" | "Limited" | "Stale" | "Not checked" {
  if (projection.kind === "stale") return "Stale";
  if (projection.kind === "not_checked" || projection.kind === "unavailable") {
    return "Not checked";
  }
  switch (projection.severity) {
    case "healthy":
      return "Healthy";
    case "running_low":
      return "Running low";
    case "limited":
      return "Limited";
  }
}
