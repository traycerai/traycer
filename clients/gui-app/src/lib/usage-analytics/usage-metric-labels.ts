import type { UsageMetric } from "@/lib/usage-analytics/usage-chart-data";

/**
 * What each metric is CALLED on screen. Lives here rather than in the
 * toggle component's file so non-component consumers (the image export's
 * subheading, whose toggle sits outside the captured region) can import it
 * without tripping fast-refresh's components-only-exports rule - while the
 * toggle still renders these exact strings, so the tab the reader clicked
 * and any surface that names the selection can never drift apart.
 */
export const USAGE_METRIC_LABELS: Readonly<Record<UsageMetric, string>> = {
  cost: "Cost",
  tokens: "Tokens",
};
