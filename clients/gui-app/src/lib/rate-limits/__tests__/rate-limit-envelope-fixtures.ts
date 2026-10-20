import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { NO_EPISODE } from "@/lib/rate-limits/rate-limit-envelope";

/**
 * A fresh, cold-start envelope wrapping a single response - matches what the
 * production `mapResponseToProviderRateLimitEnvelope` wrapper would produce
 * for a provider's first successful pull. `lastGoodAt` is the one thing
 * callers vary (a fixed timestamp for deterministic assertions, or
 * `Date.now()` where only relative freshness matters). The episode is
 * `NO_EPISODE` throughout: these envelopes are read by the surfaces that DRAW
 * a reading, and a run of failures is only ever named by the builder.
 */
export function envelopeFromRateLimits(
  data: ProviderRateLimits,
  lastGoodAt: number,
): ProviderRateLimitEnvelope {
  if (data.available) {
    return {
      latest: data,
      lastGood: data,
      lastGoodAt,
      lastFailureAt: null,
      credentialGeneration: null,
      episode: NO_EPISODE,
    };
  }
  return {
    latest: data,
    lastGood: null,
    lastGoodAt: null,
    lastFailureAt: null,
    credentialGeneration: null,
    episode: NO_EPISODE,
  };
}
