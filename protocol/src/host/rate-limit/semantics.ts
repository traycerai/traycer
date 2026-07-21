import type { ProviderRateLimits, ProviderRateLimitWindow } from "./schemas";

export type ProviderRateLimitSeverity =
  "healthy" | "running_low" | "limited" | "unknown";

export type LiveProviderRateLimitSeverity = Exclude<
  ProviderRateLimitSeverity,
  "unknown"
>;

const SHORT_WINDOW_RUNNING_LOW_USED_PERCENT = 80;
const LONG_WINDOW_RUNNING_LOW_USED_PERCENT = 95;
const LIMITED_USED_PERCENT = 100;
const SHORT_WINDOW_MAX_DURATION_MINUTES = 24 * 60;

function runningLowUsedPercentThreshold(
  window: ProviderRateLimitWindow,
): number {
  return window.durationMinutes !== null &&
    window.durationMinutes <= SHORT_WINDOW_MAX_DURATION_MINUTES
    ? SHORT_WINDOW_RUNNING_LOW_USED_PERCENT
    : LONG_WINDOW_RUNNING_LOW_USED_PERCENT;
}

/**
 * Classifies one current provider window by consumed percentage. Short
 * (at-most-24-hour) windows warn at 80%; long or undated windows warn at 95%;
 * every window becomes limited at 100%.
 */
export function classifyProviderRateLimitWindow(
  window: ProviderRateLimitWindow,
): LiveProviderRateLimitSeverity {
  if (window.usedPercent >= LIMITED_USED_PERCENT) return "limited";
  if (window.usedPercent >= runningLowUsedPercentThreshold(window)) {
    return "running_low";
  }
  return "healthy";
}

/** Every percentage window carried by a detailed provider snapshot. */
export function providerRateLimitWindows(
  rateLimits: ProviderRateLimits,
): readonly ProviderRateLimitWindow[] {
  if (!rateLimits.available) return [];
  switch (rateLimits.provider) {
    case "claude-code":
      return [
        rateLimits.fiveHour,
        rateLimits.sevenDay,
        rateLimits.sevenDayOpus,
        rateLimits.sevenDaySonnet,
        ...rateLimits.modelScoped,
      ].filter((window): window is ProviderRateLimitWindow => window !== null);
    case "codex":
      return [
        rateLimits.primary,
        rateLimits.secondary,
        ...rateLimits.extraWindows.flatMap((window) => [
          window.primary,
          window.secondary,
        ]),
      ].filter((window): window is ProviderRateLimitWindow => window !== null);
    case "openrouter":
    case "kilocode":
      return [];
  }
}

/** A null reset is live because there is no evidence that the window rolled. */
export function isProviderRateLimitWindowLive(
  window: ProviderRateLimitWindow,
  now: number,
): boolean {
  return window.resetsAt === null || window.resetsAt > now;
}

/** Detailed percentage windows that still describe the current limit period. */
export function liveProviderRateLimitWindows(
  rateLimits: ProviderRateLimits,
  now: number,
): readonly ProviderRateLimitWindow[] {
  return providerRateLimitWindows(rateLimits).filter((window) =>
    isProviderRateLimitWindowLive(window, now),
  );
}

/**
 * Classifies a whole provider snapshot. A Codex reached-type is authoritative,
 * except when every window from that same capture has expired. Missing,
 * unavailable, and fully expired detail is Unknown rather than Healthy.
 */
export function classifyProviderRateLimits(
  rateLimits: ProviderRateLimits,
  now: number,
): ProviderRateLimitSeverity {
  if (!rateLimits.available) return "unknown";
  const windows = providerRateLimitWindows(rateLimits);
  const liveWindows = windows.filter((window) =>
    isProviderRateLimitWindowLive(window, now),
  );
  if (windows.length > 0 && liveWindows.length === 0) return "unknown";
  if (
    rateLimits.provider === "codex" &&
    rateLimits.rateLimitReachedType !== null
  ) {
    return "limited";
  }
  if (liveWindows.length === 0) return "unknown";

  const severities = liveWindows.map(classifyProviderRateLimitWindow);
  if (severities.includes("limited")) return "limited";
  if (severities.includes("running_low")) return "running_low";
  return "healthy";
}
