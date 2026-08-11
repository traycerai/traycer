import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

export type UsageSummaryTotals = UsageSummaryResponse["summary"]["totals"];
export type UsageCostCoverage = UsageSummaryResponse["coverage"];
export type UsageServedBy = UsageSummaryResponse["servedBy"];

/**
 * The exact standing footnote every priced headline carries - the
 * pricing-provenance artifact's binding product framing (amended
 * 2026-08-10, fixup-01): asterisk on the figure, this five-word footnote
 * below it, matching t3code's density. Centralized so no render site can
 * drift from the exact wording.
 */
const FOOTNOTE_BASE = "* if billed at full API rate";

const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Standard 2-decimal USD, with one carve-out: a REAL but sub-half-cent
 * amount reads "<$0.01" rather than rounding down to "$0.01"'s neighbour
 * "$0.00", which a reader takes as free. A short or heavily cached turn
 * lands there routinely, and this helper prices every dashboard, epic,
 * chat and turn figure, so the rounding would otherwise show real billable
 * usage as costing nothing. `0` itself still formats as "$0.00" - that one
 * IS a measured zero. Same shape the chat cost row already uses for its own
 * finer-grained threshold ("<$0.0001").
 */
export function formatUsd(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.005) return "<$0.01";
  return USD_FORMAT.format(amountUsd);
}

export interface UsageCostHeadline {
  /** The dollar figure with its trailing asterisk, or a no-usage sentence when there is nothing to price. */
  readonly amount: string;
  /**
   * `null` only when there is no usage at all (no asterisk to explain).
   * Otherwise always the five-word base text, plus the one standing
   * exception - "· N turns not counted" - while unpriced turns exist.
   */
  readonly footnote: string | null;
}

/**
 * The headline + footnote pairing (fixup-01): a bare, unqualified dollar
 * figure never appears - every priced total carries its asterisk, and the
 * footnote is the ONLY place coverage gaps get standing pixels, via the one
 * allowed suffix. Everything else that used to live here (the "priced
 * subtotal" phrasing, the provenance split) has moved into
 * {@link usageCostTooltip}.
 */
export function describeCostHeadline(
  totals: UsageSummaryTotals,
  coverage: UsageCostCoverage,
): UsageCostHeadline {
  if (totals.factCount === 0) {
    return { amount: "No usage in this window", footnote: null };
  }
  const amount = `${formatUsd(totals.knownCostUsd)}*`;
  if (coverage.unpricedFactCount === 0) {
    return { amount, footnote: FOOTNOTE_BASE };
  }
  const turnWord = coverage.unpricedFactCount === 1 ? "turn" : "turns";
  return {
    amount,
    footnote: `${FOOTNOTE_BASE} · ${coverage.unpricedFactCount} ${turnWord} not counted`,
  };
}

/**
 * Plain-English tooltip content for the figure/asterisk - everything the
 * old standing text used to say, now on-demand: the estimate-at-list-prices
 * framing, that a subscription bills separately, the exact-vs-estimate
 * split with amounts, and the not-counted detail. The words "provenance",
 * "modeled", and "unpriced" never appear here (fixup-01, user ruling) - call
 * only when `totals.factCount > 0` (nothing to explain about an empty
 * window).
 */
export function usageCostTooltip(
  totals: UsageSummaryTotals,
  coverage: UsageCostCoverage,
): string {
  const { providerReported, modelPriced } = totals.provenanceSplit;
  const sentences = [
    "This is an estimate based on public list prices — your subscription plan bills separately.",
    `${formatUsd(providerReported.costUsd)} is from exact pricing, ${formatUsd(modelPriced.costUsd)} is estimated from public rates.`,
  ];
  if (coverage.unpricedFactCount > 0) {
    const turnWord = coverage.unpricedFactCount === 1 ? "turn" : "turns";
    const verb = coverage.unpricedFactCount === 1 ? "isn't" : "aren't";
    sentences.push(
      `${coverage.unpricedFactCount} ${turnWord} had no pricing available and ${verb} included.`,
    );
  }
  return sentences.join(" ");
}

/**
 * What this figure actually covers, whenever that is narrower than "your
 * account". A total that spans one machine, or one machine's worth of an
 * account, must never read as the cross-device total (the comm-graph
 * fallback bug the replication-and-read-path artifact names explicitly).
 *
 * Two independent narrowings, and the copy names whichever applies:
 *
 * - `servedBy: "local"` - a bounded local-plane query over facts captured on
 *   THIS machine. Not a choice the reader made, and not one they can undo
 *   here, so it leads with what the number is rather than with a host name.
 * - `hostScopeName` - the reader picked one host out of the account on the
 *   cloud plane. `null` = no host filter (the "All hosts" default), which is
 *   the one case that needs no note at all.
 */
export function servedByScopeNote(
  servedBy: UsageServedBy,
  hostScopeName: string | null,
): string | null {
  if (servedBy === "local") {
    return "This machine's usage only — not synced across your other devices.";
  }
  if (hostScopeName === null) return null;
  return `${hostScopeName} only — your other hosts aren't included.`;
}
