import type { ReactNode } from "react";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { UsageCacheSavingsTile } from "@/lib/usage-analytics/usage-stat-tiles";
import { cn } from "@/lib/utils";

type UsageSummaryTotals = {
  readonly knownCostUsd: number;
  readonly provenanceSplit: {
    readonly unpriced: { readonly costUsd: number };
    readonly modelPriced: { readonly costUsd: number };
    readonly providerReported: { readonly costUsd: number };
  };
};

export interface UsageCostQualityPanelProps {
  readonly totals: UsageSummaryTotals;
  readonly cacheSavings: UsageCacheSavingsTile;
}

/**
 * Same three-step green/amber/muted ramp `sweep-worktrees-dialog.tsx` uses
 * for its tier pills (proven-safe / review / neutral) - reused here for the
 * pricing-provenance artifact's own ladder (provider-reported is the most
 * trustworthy rung, unpriced the least), rather than inventing a second
 * status vocabulary for the same "how much do I trust this" shape.
 */
const PROVENANCE_ROWS: ReadonlyArray<{
  readonly key: "providerReported" | "modelPriced" | "unpriced";
  readonly label: string;
  readonly colorClass: string;
}> = [
  {
    key: "providerReported",
    label: "Provider-reported",
    colorClass: "bg-emerald-500",
  },
  { key: "modelPriced", label: "Modeled rate", colorClass: "bg-amber-500" },
  { key: "unpriced", label: "Unpriced", colorClass: "bg-muted-foreground/40" },
];

/**
 * % of the window's cost by provenance rung (provider-reported / modeled
 * rate / unpriced) plus the known cache-savings figure - the "how much do I
 * trust this total, and how much did caching save" panel. Shares are
 * computed against the sum of the three provenance buckets' OWN costs (not
 * `totals.knownCostUsd` directly) so they foot to 100% even though
 * `unpriced`'s bucket cost is always `0` by construction.
 */
export function UsageCostQualityPanel(
  props: UsageCostQualityPanelProps,
): ReactNode {
  const { totals, cacheSavings } = props;
  const split = totals.provenanceSplit;
  const totalCost =
    split.providerReported.costUsd +
    split.modelPriced.costUsd +
    split.unpriced.costUsd;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4"
      data-testid="usage-cost-quality-panel"
    >
      <h3 className="text-ui-sm font-medium text-foreground">Cost quality</h3>
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
        aria-hidden
      >
        {PROVENANCE_ROWS.map((row) => {
          const cost = split[row.key].costUsd;
          const share = totalCost > 0 ? (cost / totalCost) * 100 : 0;
          if (share <= 0) return null;
          return (
            <span
              key={row.key}
              className={cn("block h-full", row.colorClass)}
              style={{ width: `${String(share)}%` }}
            />
          );
        })}
      </div>
      <ul className="flex flex-col gap-1.5">
        {PROVENANCE_ROWS.map((row) => {
          const cost = split[row.key].costUsd;
          const share = totalCost > 0 ? (cost / totalCost) * 100 : 0;
          return (
            <li
              key={row.key}
              className="flex items-center gap-2 text-ui-sm"
              data-testid={`usage-cost-quality-row-${row.key}`}
            >
              <span
                aria-hidden
                className={cn("h-2 w-2 shrink-0 rounded-full", row.colorClass)}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {row.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {share.toFixed(0)}%
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {formatUsd(cost)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border/60 pt-3 text-ui-sm">
        <span className="text-muted-foreground">Cache savings (known): </span>
        <span className="font-medium tabular-nums text-foreground">
          {formatUsd(cacheSavings.knownCacheSavingsUsd)}
        </span>
        {cacheSavings.multipleOfRawCost === null ? null : (
          <span className="text-muted-foreground">
            {" "}
            — {cacheSavings.multipleOfRawCost.toFixed(1)}x raw cost
          </span>
        )}
      </div>
    </div>
  );
}
