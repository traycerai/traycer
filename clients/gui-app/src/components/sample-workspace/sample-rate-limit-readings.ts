import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";
import { sampleUsageReading } from "./sample-workspace-scene";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

const MINUTE_MS = 60_000;
const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;
const MONTH = 30 * 24 * 60;

/**
 * The snapshot a provider's usage segment reads while the sample scene is up,
 * or `null` for a provider with no windows to fill.
 *
 * It stands in for the host's reading BEFORE the strip's own window catalog and
 * limit selection run, so a sample segment keeps every fixed window the
 * provider reports, under the same keys: a user who picked a weekly or several
 * windows sees that pick drawn, just over invented numbers (C12). `slot` is
 * the segment's place in the strip, so neighbouring segments rotate through
 * different readings.
 *
 * ponytail: payload-discovered windows (claude's model-scoped, codex's extra
 * limits) are not invented; a pick naming one falls back to the tightest.
 */
export function sampleProviderRateLimits(
  providerId: RateLimitProviderId,
  slot: number,
  now: number,
): ProviderRateLimits | null {
  const window = (offset: number, durationMinutes: number) =>
    sampleWindow(slot + offset, durationMinutes, now);
  switch (providerId) {
    case "claude-code":
      return {
        provider: "claude-code",
        available: true,
        subscriptionType: null,
        fiveHour: window(0, FIVE_HOURS),
        sevenDay: window(1, WEEK),
        sevenDayOpus: window(2, WEEK),
        sevenDaySonnet: window(3, WEEK),
        modelScoped: [],
        extraUsage: null,
      };
    case "codex":
      return {
        provider: "codex",
        available: true,
        planType: null,
        limitId: null,
        limitName: null,
        primary: window(0, FIVE_HOURS),
        secondary: window(1, WEEK),
        extraWindows: [],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      };
    case "opencode":
      return {
        provider: "opencode",
        available: true,
        credentialGeneration: "sample",
        fiveHour: { ...window(0, FIVE_HOURS), status: "ok" },
        weekly: { ...window(1, WEEK), status: "ok" },
        monthly: { ...window(2, MONTH), status: "ok" },
      };
    case "grok": {
      const period = window(0, MONTH);
      return {
        provider: "grok",
        available: true,
        subscriptionTier: null,
        periodType: null,
        periodStart: null,
        periodEnd: period.resetsAt,
        period,
        monthlyLimit: null,
        onDemandCap: null,
        onDemandUsed: null,
        prepaidBalance: null,
      };
    }
    case "cursor": {
      // Both buckets reset on the billing cycle; the wire requires one instant.
      const cursorModels = window(0, MONTH);
      return {
        provider: "cursor",
        available: true,
        cycleStart: null,
        cycleEnd: cursorModels.resetsAt,
        cursorModels,
        otherModels: { ...window(1, MONTH), resetsAt: cursorModels.resetsAt },
        includedLimitUsd: null,
        usedUsd: null,
        remainingUsd: null,
        bonusUsedUsd: null,
        onDemandLimitType: null,
        onDemandLimitUsd: null,
        onDemandUsedUsd: null,
        onDemandRemainingUsd: null,
        displayMessage: null,
      };
    }
    // Antigravity has only payload-discovered windows, never fixed sample slots.
    case "antigravity":
    case "openrouter":
    case "kilocode":
    case "huggingface":
      return null;
  }
}

/**
 * One window of the given length, its percentage taken from the shared sample
 * set and its reset placed where that much use of the window would put it, so
 * no sample reads as running ahead of its pace.
 */
function sampleWindow(
  slot: number,
  durationMinutes: number,
  now: number,
): ProviderRateLimitWindow & { readonly resetsAt: number } {
  const { usedPercent } = sampleUsageReading(slot);
  const resetsInMinutes = Math.round(
    (durationMinutes * (100 - usedPercent)) / 100,
  );
  return {
    usedPercent,
    resetsAt: now + resetsInMinutes * MINUTE_MS,
    durationMinutes,
  };
}
