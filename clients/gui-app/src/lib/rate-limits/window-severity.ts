/**
 * Fixed severity scale for a single rate-limit window's used percentage,
 * shared by the header glyph and every `MeterRow` bar. Usage stays blue
 * through 85%, then turns red; 0% used renders as an empty blue bar.
 */
export type RateLimitWindowSeverity = "blue" | "red";

export function rateLimitWindowSeverity(
  usedPercent: number,
): RateLimitWindowSeverity {
  if (usedPercent > 85) return "red";
  return "blue";
}

/** Tailwind fill color for a severity tier, matching the Core Flows wireframe's bar colors. */
export function rateLimitWindowSeverityBarClassName(
  severity: RateLimitWindowSeverity,
): string {
  switch (severity) {
    case "red":
      return "bg-red-500 dark:bg-red-400";
    case "blue":
      return "bg-blue-500 dark:bg-blue-400";
  }
}

/**
 * The width (0-100) a severity-colored window bar should fill. This tracks the
 * real used percentage, clamped to [0, 100].
 */
export function rateLimitWindowFillPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, usedPercent));
}
