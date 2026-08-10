import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  describeCostCoverage,
  FULL_RATE_QUALIFIER,
  servedByScopeNote,
  type UsageCostCoverage,
  type UsageServedBy,
  type UsageSummaryTotals,
} from "@/lib/usage-analytics/cost-format";

export interface UsageCostFigureProps {
  readonly totals: UsageSummaryTotals;
  readonly coverage: UsageCostCoverage;
  readonly servedBy: UsageServedBy;
  readonly size: "compact" | "default";
}

/**
 * The one place every honesty element for a cost total is composed:
 * - the "at full API rate" qualifier, on every figure, always
 * - a priced-subtotal note whenever coverage is incomplete (never a bare
 *   number that looks complete but isn't)
 * - the local-plane scope note when `servedBy: "local"`
 */
export function UsageCostFigure(props: UsageCostFigureProps): ReactNode {
  const { totals, coverage, servedBy, size } = props;
  const { headline, coverageNote } = describeCostCoverage(totals, coverage);
  const scopeNote = servedByScopeNote(servedBy);
  const compact = size === "compact";

  return (
    <div className="flex flex-col gap-0.5" data-testid="usage-cost-figure">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span
          className={cn(
            "font-semibold tabular-nums text-foreground",
            compact ? "text-ui-sm" : "text-title-md",
          )}
        >
          {headline}
        </span>
        {coverageNote === null ? null : (
          <span className="text-ui-xs text-muted-foreground">
            {coverageNote}
          </span>
        )}
      </div>
      {totals.factCount === 0 ? null : (
        <p className="text-ui-xs text-muted-foreground/80">
          {FULL_RATE_QUALIFIER} — subscription plans bill separately.
        </p>
      )}
      {scopeNote === null ? null : (
        <p
          className="text-ui-xs text-muted-foreground/80"
          data-testid="usage-served-by-local-note"
        >
          {scopeNote}
        </p>
      )}
    </div>
  );
}
