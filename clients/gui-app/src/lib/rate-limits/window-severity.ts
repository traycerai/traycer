import type { LiveProviderRateLimitSeverity } from "@traycer/protocol/host/rate-limit";

export type RateLimitWindowSeverity = LiveProviderRateLimitSeverity;

/** Binary severity for credit/balance meters that have no reset window. */
export function creditUsageSeverity(
  usedPercent: number,
): RateLimitWindowSeverity {
  return usedPercent > 85 ? "limited" : "healthy";
}

/** Tailwind fill color for a severity tier, matching the Core Flows wireframe's bar colors. */
export function rateLimitWindowSeverityBarClassName(
  severity: RateLimitWindowSeverity,
): string {
  switch (severity) {
    case "limited":
      return "bg-red-500 dark:bg-red-400";
    case "running_low":
      return "bg-amber-500 dark:bg-amber-400";
    case "healthy":
      return "bg-blue-500 dark:bg-blue-400";
  }
}

/**
 * Tailwind text color for a severity tier, for the surfaces that print the
 * percentage without room for a bar beside it.
 *
 * The same thresholds as the bar, deliberately: the status bar's collapse
 * ladder drops the mini bar long before it drops the number, and a percentage
 * that changed color only while a bar happened to be drawn would make severity
 * a property of how wide the window is.
 *
 * Text weights differ from fills, and per tier rather than uniformly: a fill is
 * judged by area, a 12px numeral by contrast. The 500 shades the bar uses miss
 * the 4.5:1 floor on a light canvas, so each light tier steps to the first
 * shade that clears it - red and blue at 600, and amber only at 700, which is
 * the darkest of the three because yellow is the brightest. Amber going one
 * further than its neighbours is the point rather than an inconsistency; it is
 * also the tier that means act on this limit now.
 */
export function rateLimitWindowSeverityTextClassName(
  severity: RateLimitWindowSeverity,
): string {
  switch (severity) {
    case "limited":
      return "text-red-600 dark:text-red-400";
    case "running_low":
      return RUNNING_LOW_TEXT_CLASS_NAME;
    case "healthy":
      return "text-blue-600 dark:text-blue-400";
  }
}

/**
 * Shared with the status bar's degraded glyph, which sits inches from a
 * `running_low` percentage on the same row: two ambers a shade apart read as a
 * rendering fault rather than as two ideas.
 */
export const RUNNING_LOW_TEXT_CLASS_NAME = "text-amber-700 dark:text-amber-400";

/**
 * The width (0-100) a severity-colored window bar should fill. This tracks the
 * real used percentage, clamped to [0, 100].
 */
export function rateLimitWindowFillPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, usedPercent));
}
