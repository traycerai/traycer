/**
 * Fixed severity scale for a single rate-limit window's used percentage -
 * shared by the header glyph (Rate Limit Bar Icon - Core Flows, "Icon
 * composition") and every bar `MeterRow` renders ("Provider detail view"
 * explicitly reuses these same thresholds) - the single scale every
 * provider's capped and uncapped bars share, so no row anywhere uses a
 * different palette or thresholds.
 *
 * `"green"` is a distinct fourth tier for a window at 0% used (100% available):
 * it renders as a fully-filled green bar (see `rateLimitWindowFillPercent`) so
 * "nothing used yet" reads unambiguously as healthy, rather than as an empty
 * blue-tier bar.
 */
export type RateLimitWindowSeverity = "green" | "blue" | "yellow" | "red";

export function rateLimitWindowSeverity(
  usedPercent: number,
): RateLimitWindowSeverity {
  if (usedPercent <= 0) return "green";
  if (usedPercent > 85) return "red";
  if (usedPercent >= 60) return "yellow";
  return "blue";
}

/** Tailwind fill color for a severity tier, matching the Core Flows wireframe's bar colors. */
export function rateLimitWindowSeverityBarClassName(
  severity: RateLimitWindowSeverity,
): string {
  switch (severity) {
    case "red":
      return "bg-red-500 dark:bg-red-400";
    case "yellow":
      return "bg-yellow-500 dark:bg-yellow-400";
    case "blue":
      return "bg-blue-500 dark:bg-blue-400";
    case "green":
      return "bg-green-500 dark:bg-green-400";
  }
}

/**
 * The width (0-100) a severity-colored window bar should fill. A window at 0%
 * used (100% available) fills the whole track - paired with the `"green"`
 * severity - so it reads as a full green bar rather than an empty one;
 * otherwise the bar tracks the real used percentage, clamped to [0, 100]. This
 * is the *fill* only: callers still derive any "% left/used" text from the real
 * `usedPercent`, not from this forced-full value.
 */
export function rateLimitWindowFillPercent(usedPercent: number): number {
  if (usedPercent <= 0) return 100;
  return Math.min(100, Math.max(0, usedPercent));
}
