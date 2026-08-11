import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  describeCostHeadline,
  servedByScopeNote,
  usageCostTooltip,
  type UsageCostCoverage,
  type UsageServedBy,
  type UsageSummaryTotals,
} from "@/lib/usage-analytics/cost-format";

export interface UsageCostFigureProps {
  readonly totals: UsageSummaryTotals;
  readonly coverage: UsageCostCoverage;
  readonly servedBy: UsageServedBy;
  /**
   * The host this figure was narrowed to, when the reader picked one -
   * `null` for an unfiltered read AND for every surface where the host
   * dimension does not apply (the epic- and chat-scoped dialogs, whose
   * subject is the same work wherever it ran).
   */
  readonly hostScopeName: string | null;
  readonly size: "compact" | "default";
}

/**
 * The one place every honesty element for a cost total is composed - at
 * t3code's density (user ruling 2026-08-10, fixup-01): the headline carries
 * its own asterisk, a five-word footnote sits below it ("* if billed at
 * full API rate"), and a "· N turns not counted" suffix is the ONE thing
 * allowed to claim extra standing pixels, only while unpriced turns exist.
 * Everything else - the estimate-at-list-prices explanation, the
 * subscription-bills-separately note, the exact-vs-estimate split with
 * amounts, the not-counted detail - lives in a tooltip on the figure
 * itself, never as standing text. Still the single owner of this
 * presentation so the rule can't fragment across surfaces.
 */
export function UsageCostFigure(props: UsageCostFigureProps): ReactNode {
  const { totals, coverage, servedBy, hostScopeName, size } = props;
  const { amount, footnote } = describeCostHeadline(totals, coverage);
  const tooltip =
    totals.factCount === 0 ? null : usageCostTooltip(totals, coverage);
  const scopeNote = servedByScopeNote(servedBy, hostScopeName);
  const compact = size === "compact";
  const amountClassName = cn(
    "font-semibold tabular-nums text-foreground",
    compact ? "text-ui-sm" : "text-title-md",
  );

  return (
    <div className="flex flex-col gap-0.5" data-testid="usage-cost-figure">
      {tooltip === null ? (
        <span className={amountClassName}>{amount}</span>
      ) : (
        <TooltipWrapper
          label={tooltip}
          side="bottom"
          sideOffset={undefined}
          align="start"
        >
          {/* A real button, not `tabIndex` on a span
              (jsx-a11y/no-noninteractive-tabindex) - the only way a
              keyboard/AT user can reach this tooltip's explanation without a
              mouse. No `onClick`: focus alone is its job. */}
          <button
            type="button"
            className={cn(
              amountClassName,
              "cursor-default rounded-sm bg-transparent text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            {amount}
          </button>
        </TooltipWrapper>
      )}
      {footnote === null ? null : (
        <p
          className="text-ui-xs text-muted-foreground/80"
          data-testid="usage-cost-footnote"
        >
          {footnote}
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
