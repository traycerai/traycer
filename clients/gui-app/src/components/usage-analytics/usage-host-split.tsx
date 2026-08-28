import type { ReactNode } from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { UsageHostSplitRow } from "@/lib/usage-analytics/usage-host-split";
import { cn } from "@/lib/utils";

export interface UsageHostSplitProps {
  readonly rows: readonly UsageHostSplitRow[];
}

/**
 * Per-host cost split: one row per host with a share bar, its % of the
 * window's cost, its cost and its token total. Same column anatomy and
 * fluid-sizing rules as `UsageHarnessSplit` so the two breakdowns read as one
 * vocabulary rather than two designs.
 *
 * Deliberately NOT keyed to the daily chart's series scale. That scale colors
 * HARNESSES, and reusing it here would paint a host and a harness the same
 * hue in the same view - the exact opposite of "color follows the entity".
 * Hosts are not a series in any chart on this page, so one neutral accent
 * across every row is the honest encoding: the bar carries magnitude, and
 * nothing about the color claims an identity.
 */
export function UsageHostSplit(props: UsageHostSplitProps): ReactNode {
  if (props.rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" data-testid="usage-host-split">
      {props.rows.map((row) => (
        <UsageHostSplitItem key={row.hostId} row={row} />
      ))}
    </ul>
  );
}

function UsageHostSplitItem(props: {
  readonly row: UsageHostSplitRow;
}): ReactNode {
  const { row } = props;
  const percentLabel = `${(row.shareOfCost * 100).toFixed(1)}%`;
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid={`usage-host-split-row-${row.hostId}`}
    >
      {/* The full id is worth reaching for whichever way the label reads: a
          truncated id needs its remaining characters, and a NAMED host is
          the case where the id is otherwise nowhere on screen at all. */}
      <TooltipWrapper
        label={row.hostId}
        side="top"
        sideOffset={undefined}
        align="start"
      >
        <span
          className={cn(
            "w-32 min-w-0 shrink truncate text-ui-sm",
            // A truncated id is a real host we simply cannot name, so it is
            // muted rather than hidden - never a blank cell.
            row.nameIsFallback ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {row.name}
        </span>
      </TooltipWrapper>
      <span
        className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-foreground/8"
        role="img"
        aria-label={`${percentLabel} of cost`}
      >
        <span
          className="block h-full rounded-full bg-foreground/40"
          style={{ width: `${String(Math.min(100, row.shareOfCost * 100))}%` }}
        />
      </span>
      <span className="min-w-14 shrink-0 text-right tabular-nums text-ui-xs text-muted-foreground">
        {percentLabel}
      </span>
      <span className="min-w-16 shrink-0 text-right tabular-nums text-ui-sm font-medium text-foreground">
        {formatUsd(row.costUsd)}
      </span>
      <span className="min-w-16 shrink-0 text-right tabular-nums text-ui-xs text-muted-foreground">
        {row.tokens.toLocaleString()}
      </span>
    </li>
  );
}
