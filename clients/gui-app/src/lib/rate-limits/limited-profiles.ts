import type { StatusBarRateLimitCluster } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Providers with at least one profile the host reports as `limited` on any of
 * its windows, for the usage popover's provider rail. The host decides the
 * tier (`semantics.ts`); this only collects the providers that reached it.
 */
export function limitedProviderIds(
  cluster: StatusBarRateLimitCluster,
): ReadonlySet<RateLimitProviderId> {
  if (cluster.kind !== "segments") return new Set();
  return new Set(
    cluster.segments
      .filter((segment) =>
        segment.windows.some((window) => window.severity === "limited"),
      )
      .map((segment) => segment.providerId),
  );
}
