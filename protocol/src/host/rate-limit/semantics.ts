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
    case "grok":
      // Hybrid arm: the synthesized billing-period window feeds the shared
      // severity/rollup path. A period-less snapshot (tier + dates only, no
      // usage percentage) carries no window.
      return rateLimits.period !== null ? [rateLimits.period] : [];
    case "jcode":
      // Meta-harness arm: one window per connected sub-provider that reported a
      // measurable quota. This is the same many-windows-per-provider shape
      // claude-code already contributes, so it folds into the shared severity
      // rollup with no special casing. A sub-provider whose fetch failed (its
      // `error` is non-null) carries a null window and simply contributes
      // nothing - it must never read as a healthy zero.
      return rateLimits.subProviders
        .map((subProvider) => subProvider.window)
        .filter((window): window is ProviderRateLimitWindow => window !== null);
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
 * Display name for one jcode quota row. jcode reports a LIST of named limits
 * per connected sub-provider, so `subProviderId` alone is ambiguous the moment
 * a provider returns more than one - two Copilot rows would read identically
 * and, in a keyed list, collide. Shared by the settings meter, the
 * agent-facing text formatter and the profile-usage projection so those three
 * surfaces cannot drift apart on what a row is called.
 */
export function jcodeSubProviderRateLimitLabel(subProvider: {
  readonly subProviderId: string;
  readonly limitName: string | null;
}): string {
  return subProvider.limitName === null
    ? subProvider.subProviderId
    : `${subProvider.subProviderId} · ${subProvider.limitName}`;
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
  if (
    rateLimits.provider === "jcode" &&
    rateLimits.subProviders.some(
      (subProvider) =>
        subProvider.hardLimitReached &&
        // Per-ROW liveness, not the snapshot-wide guard above. jcode is the
        // only LIST arm, so one capture mixes rows with independent reset
        // times: an OpenRouter row that hit 100% and has since rolled over
        // must not make a healthy live Copilot row report limited. The
        // all-expired guard cannot catch that - it only fires when EVERY row
        // is stale. A row with no window (or no reset time) has no evidence
        // of rolling over, so it stays authoritative, matching
        // `isProviderRateLimitWindowLive`'s null rule.
        (subProvider.window === null ||
          isProviderRateLimitWindowLive(subProvider.window, now)),
    )
  ) {
    // Authoritative for the same reason Codex's reached-type is, and placed
    // after the same staleness guard so an all-expired capture still reports
    // Unknown. Today the host derives `hardLimitReached` from
    // `usedPercent >= 100` (jcode computes `hard_limit_reached` upstream but
    // does not serialize it), so this agrees with the window classifier by
    // construction - reading the flag rather than re-deriving it means an
    // upstream build that starts serializing a different rule is honoured here
    // instead of silently disagreeing with itself.
    return "limited";
  }
  if (liveWindows.length === 0) return "unknown";

  const severities = liveWindows.map(classifyProviderRateLimitWindow);
  if (severities.includes("limited")) return "limited";
  if (severities.includes("running_low")) return "running_low";
  return "healthy";
}
