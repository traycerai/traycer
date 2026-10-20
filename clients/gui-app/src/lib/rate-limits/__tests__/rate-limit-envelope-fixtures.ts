import type { ProviderRateLimits } from "@traycer/protocol/host";
import { isTransientRateLimitUnavailableReason } from "@traycer/protocol/host";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";

/**
 * A fresh, cold-start envelope wrapping a single response - matches what the
 * production `mapResponseToProviderRateLimitEnvelope` wrapper would produce
 * for a provider's first successful pull. `lastGoodAt` is the one thing
 * callers vary (a fixed timestamp for deterministic assertions, or
 * `Date.now()` where only relative freshness matters).
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
      lastTerminalAt: lastGoodAt,
    };
  }
  return {
    latest: data,
    lastGood: null,
    lastGoodAt: null,
    lastFailureAt: null,
    // A transient failure is no answer about the account, so it dates none;
    // an authoritative reason is one.
    lastTerminalAt: isTransientRateLimitUnavailableReason(data.reason)
      ? null
      : lastGoodAt,
  };
}
