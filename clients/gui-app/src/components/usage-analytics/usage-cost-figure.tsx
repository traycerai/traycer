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
import { USAGE_EXPORT_REDACT_ATTRIBUTE } from "@/lib/usage-analytics/usage-export-image";

export interface UsageCostFigureProps {
  readonly totals: UsageSummaryTotals;
  readonly coverage: UsageCostCoverage;
  readonly servedBy: UsageServedBy;
  /** The host this figure was narrowed to, when the reader picked one. */
  readonly hostScopeName: string | null;
  /** `display` is the epic usage dialog's hero treatment: one step larger, proportional figures. */
  readonly size: "compact" | "default" | "display";
}

/** Still the single owner of this presentation so the rule can't fragment across surfaces. */
export function UsageCostFigure(props: UsageCostFigureProps): ReactNode {
  const { totals, coverage, servedBy, hostScopeName, size } = props;
  const { amount, footnote } = describeCostHeadline(totals, coverage);
  const tooltip =
    totals.factCount === 0 ? null : usageCostTooltip(totals, coverage);
  const scopeNote = servedByScopeNote(servedBy, hostScopeName);
  // Only the host-filter branch of the note embeds a workspace-internal name, and a shared image must not carry
  // it.
  const redactedScopeNote =
    servedBy !== "local" && hostScopeName !== null
      ? "Selected host only — your other hosts aren't included."
      : null;
  const amountClassName = cn(
    "font-semibold text-foreground",
    size === "compact" && "text-ui-sm tabular-nums",
    size === "default" && "text-title-md tabular-nums",
    // No `tabular-nums` at display size on purpose: tabular figures give every digit a zero's width, which reads
    // loose on a standalone hero number - they are for columns that must align, not display type.
    size === "display" && "text-title-lg",
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
          {/* A real button, not `tabIndex` on a span (jsx-a11y/no-noninteractive-tabindex) - the only way a keyboard/AT
             user can reach this tooltip's explanation without a mouse. */}
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
          {...(redactedScopeNote === null
            ? {}
            : { [USAGE_EXPORT_REDACT_ATTRIBUTE]: redactedScopeNote })}
        >
          {scopeNote}
        </p>
      )}
    </div>
  );
}
