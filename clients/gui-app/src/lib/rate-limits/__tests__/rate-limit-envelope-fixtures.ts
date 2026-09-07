import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";

/**
 * A fresh, cold-start envelope wrapping a single response - matches what the production `mapResponseToProviderRateLimitEnvelope` wrapper would produce for a provider's first successful pull.
 */
export function envelopeFromRateLimits(
  data: ProviderRateLimits,
  lastGoodAt: number,
): ProviderRateLimitEnvelope {
  return data.available
    ? { latest: data, lastGood: data, lastGoodAt, lastFailureAt: null }
    : { latest: data, lastGood: null, lastGoodAt: null, lastFailureAt: null };
}
