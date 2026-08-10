import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import { sumTokenTotals } from "@/lib/usage-analytics/usage-chart-data";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

type UsageTurnRow = NonNullable<
  UsageSummaryResponse["summary"]["turnRows"]
>[number];
type UsageTurnOutcome = UsageTurnRow["outcome"];

export interface UsageTurnDrilldownProps {
  readonly rows: readonly UsageTurnRow[];
  /** `usage.turnRowsTruncated` - the newest-first cap was hit; older turns exist but are not shown. */
  readonly truncated: boolean;
}

/**
 * Per-turn drill-down: turn (time) → model → tokens → cost/provenance →
 * outcome, newest first (the wire's own row order). Chat-scope-only by
 * design - the summary only populates `turnRows` when the request carried a
 * `chatId` filter.
 */
export function UsageTurnDrilldown(props: UsageTurnDrilldownProps): ReactNode {
  if (props.rows.length === 0) {
    return (
      <p
        className="px-1 text-ui-sm text-muted-foreground"
        data-testid="usage-turn-drilldown-empty"
      >
        No turns in this window.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-col gap-1" data-testid="usage-turn-drilldown">
        {props.rows.map((row) => (
          <UsageTurnRowItem key={row.factId} row={row} />
        ))}
      </ul>
      {props.truncated ? (
        <p
          className="text-ui-xs text-muted-foreground/80"
          data-testid="usage-turn-drilldown-truncated-note"
        >
          Showing the newest {props.rows.length} turns — older turns are not
          shown.
        </p>
      ) : null}
    </div>
  );
}

function UsageTurnRowItem(props: { readonly row: UsageTurnRow }): ReactNode {
  const { row } = props;
  const tokens = sumTokenTotals(row.tokens);
  return (
    // `flex-wrap` plus `min-w-*` (not fixed `w-*`) on the value columns:
    // this row lives in a `w-[min(92vw,32rem)]` dialog, so on a narrow
    // window the columns' fixed widths used to add up past the content box
    // and push values out of sight. Now they keep their aligned widths
    // while there is room, and the trailing ones wrap onto a second line
    // instead of overflowing.
    <li
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/40 px-2 py-1.5 text-ui-xs"
      data-testid={`usage-turn-drilldown-row-${row.factId}`}
    >
      <span className="w-32 min-w-0 shrink truncate text-muted-foreground">
        {formatTurnTimestamp(row.occurredAt)}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {row.model}
      </span>
      <span className="min-w-16 shrink-0 text-right tabular-nums text-muted-foreground">
        {tokens.toLocaleString()}
      </span>
      <span className="min-w-14 shrink-0 text-right tabular-nums font-medium text-foreground">
        {/* `costUsd: null` means unpriced, not free - an em dash rather than $0.00. */}
        {row.costUsd === null ? "—" : formatUsd(row.costUsd)}
      </span>
      <OutcomeBadge outcome={row.outcome} />
    </li>
  );
}

function OutcomeBadge(props: {
  readonly outcome: UsageTurnOutcome;
}): ReactNode {
  switch (props.outcome) {
    case "completed":
      return <Badge variant="secondary">Completed</Badge>;
    case "stopped":
      return <Badge variant="outline">Stopped</Badge>;
    case "interrupted":
      return <Badge variant="outline">Interrupted</Badge>;
    case "abnormal_exit":
      return <Badge variant="destructive">Abnormal exit</Badge>;
  }
}

function formatTurnTimestamp(occurredAtMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(occurredAtMs));
}
