import type { LiveProviderRateLimitSeverity } from "@traycer/protocol/host/rate-limit";

export type RateLimitWindowSeverity = LiveProviderRateLimitSeverity;

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
 * The width (0-100) a severity-colored window bar should fill. This tracks the
 * real used percentage, clamped to [0, 100].
 */
export function rateLimitWindowFillPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, usedPercent));
}
