import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

export type UsageSummaryTotals = UsageSummaryResponse["summary"]["totals"];
export type UsageCostCoverage = UsageSummaryResponse["coverage"];
export type UsageServedBy = UsageSummaryResponse["servedBy"];

/**
 * The one qualifier string every dollar figure in this surface carries - the
 * pricing-provenance artifact's binding product framing: a derived dollar
 * amount is "cost if billed at full API rate", never money actually spent
 * (subscription plans bill separately). Centralized so no render site can
 * drift from the exact wording.
 */
export const FULL_RATE_QUALIFIER = "if billed at full API rate";

export function formatUsd(amountUsd: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amountUsd);
}

export interface CostCoverageText {
  /** The dollar figure itself, or a no-usage sentence when there is nothing to price. */
  readonly headline: string;
  /**
   * Non-null exactly when the total is a PARTIAL sum over nullable
   * `costUsd` - never a bare, misleadingly-complete number. Render this
   * alongside the headline, never dropped.
   */
  readonly coverageNote: string | null;
}

/**
 * Renders a cost total honestly: a `SUM` over nullable `costUsd` can never
 * silently pose as a complete total (pricing-provenance artifact). When any
 * fact in the window is unpriced, the headline states it is a subtotal and
 * the note carries the excluded count - never a bare number that looks
 * complete but isn't.
 */
export function describeCostCoverage(
  totals: UsageSummaryTotals,
  coverage: UsageCostCoverage,
): CostCoverageText {
  if (totals.factCount === 0) {
    return { headline: "No usage in this window", coverageNote: null };
  }
  const amount = formatUsd(totals.knownCostUsd);
  if (coverage.unpricedFactCount === 0) {
    return { headline: amount, coverageNote: null };
  }
  const turnWord = coverage.unpricedFactCount === 1 ? "turn" : "turns";
  return {
    headline: `${amount} priced subtotal`,
    coverageNote: `+ ${coverage.unpricedFactCount} unpriced ${turnWord}`,
  };
}

/**
 * `servedBy: "local"` means this read is a bounded local-plane query over
 * facts captured on THIS machine only - a single-host history must never
 * read as the account's cross-device total (the comm-graph fallback bug the
 * replication-and-read-path artifact names explicitly). `null` for
 * `"cloud"`, where the read already spans every device.
 */
export function servedByScopeNote(servedBy: UsageServedBy): string | null {
  if (servedBy === "cloud") return null;
  return "This machine's usage only — not synced across your other devices.";
}
