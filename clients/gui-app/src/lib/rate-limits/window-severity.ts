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
      return "bg-destructive";
    case "running_low":
      return "bg-warning";
    case "healthy":
      return "bg-info";
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
 * Text uses the `-foreground` half of each status role and the bar uses the
 * base, which is the same split the rest of the app makes: the base is a fill
 * judged by area, the foreground is text judged by contrast and is verified
 * >=3:1 against every preset surface. Before the status tokens existed this
 * function hand-picked a shade per tier to clear 4.5:1 on a light canvas
 * (amber a step darker than the others, because yellow is the brightest); the
 * tokens carry that guarantee now, and they carry it in every preset rather
 * than in the default light one.
 */
export function rateLimitWindowSeverityTextClassName(
  severity: RateLimitWindowSeverity,
): string {
  switch (severity) {
    case "limited":
      return "text-destructive";
    case "running_low":
      return RUNNING_LOW_TEXT_CLASS_NAME;
    case "healthy":
      return "text-info-foreground";
  }
}

/**
 * Shared with the status bar's degraded glyph, which sits inches from a
 * `running_low` percentage on the same row. Both now name the same token, so
 * the drift this constant existed to prevent - two ambers a shade apart,
 * reading as a rendering fault rather than as two ideas - is no longer
 * expressible; it stays as the one name both surfaces import.
 */
export const RUNNING_LOW_TEXT_CLASS_NAME = "text-warning-foreground";

/**
 * The width (0-100) a severity-colored window bar should fill. This tracks the
 * real used percentage, clamped to [0, 100].
 */
export function rateLimitWindowFillPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, usedPercent));
}
