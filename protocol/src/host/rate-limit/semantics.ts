import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUnavailableReason,
} from "./schemas";

/**
 * Reasons a rate-limit read can fail that describe THIS attempt rather than the account: `usage_fetch_failed` is the CLI's usage HTTP fetch failing (e.g. a server-side 429 on Anthropic's `/api/oauth/usage` with a.
 */
const TRANSIENT_RATE_LIMIT_UNAVAILABLE_REASONS: ReadonlySet<RateLimitUnavailableReason> =
  new Set(["usage_fetch_failed", "timeout", "connection_failed"]);

export function isTransientRateLimitUnavailableReason(
  reason: RateLimitUnavailableReason,
): boolean {
  return TRANSIENT_RATE_LIMIT_UNAVAILABLE_REASONS.has(reason);
}

/**
 * Snapshot-level form of `isTransientRateLimitUnavailableReason`: whether this whole reading is a failed attempt that a previously captured reading should survive.
 * An `available: true` snapshot is never transient - it IS the reading.
 */
export function isTransientProviderRateLimitFailure(
  rateLimits: ProviderRateLimits,
): boolean {
  return (
    !rateLimits.available &&
    isTransientRateLimitUnavailableReason(rateLimits.reason)
  );
}

export type ProviderRateLimitSeverity =
  | "healthy"
  | "running_low"
  | "limited"
  | "unknown";

export type LiveProviderRateLimitSeverity = Exclude<
  ProviderRateLimitSeverity,
  "unknown"
>;

export type OpenCodeGoRateLimitWindow = Extract<
  ProviderRateLimits,
  { provider: "opencode"; available: true }
>["fiveHour"];

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

/** Classifies one current provider window by consumed percentage. */
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
      // Hybrid arm: the synthesized billing-period window feeds the shared severity/rollup path.
      return rateLimits.period !== null ? [rateLimits.period] : [];
    case "cursor":
      return [rateLimits.cursorModels, rateLimits.otherModels].filter(
        (window): window is ProviderRateLimitWindow => window !== null,
      );
    case "opencode":
      return [rateLimits.fiveHour, rateLimits.weekly, rateLimits.monthly];
    case "openrouter":
    case "kilocode":
    case "huggingface":
      // Credit providers: the payload is money, not a percentage of a rolling
      // window, so there is nothing the shared window primitive can describe.
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

/** OpenCode's status is authoritative only while that captured window is live. */
export function isOpenCodeGoRateLimitWindowLimited(
  window: OpenCodeGoRateLimitWindow,
  now: number,
): boolean {
  return (
    window.status === "rate-limited" &&
    isProviderRateLimitWindowLive(window, now)
  );
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

/** Classifies a whole provider snapshot. */
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
    rateLimits.provider === "opencode" &&
    [rateLimits.fiveHour, rateLimits.weekly, rateLimits.monthly].some(
      (window) => isOpenCodeGoRateLimitWindowLimited(window, now),
    )
  ) {
    return "limited";
  }
  if (liveWindows.length === 0) return "unknown";

  const severities = liveWindows.map(classifyProviderRateLimitWindow);
  if (severities.includes("limited")) return "limited";
  if (severities.includes("running_low")) return "running_low";
  return "healthy";
}
