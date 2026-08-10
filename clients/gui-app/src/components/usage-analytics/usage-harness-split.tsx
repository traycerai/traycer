import type { ReactNode } from "react";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { UsageHarnessSplitRow } from "@/lib/usage-analytics/usage-harness-split";
import type { UsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";
import { cn } from "@/lib/utils";

export interface UsageHarnessSplitProps {
  readonly rows: readonly UsageHarnessSplitRow[];
  /** Ties each row's dot/bar color to the daily chart's legend - same entity, same color, never re-derived. */
  readonly scale: UsageSeriesScale;
}

/**
 * Per-harness cost split under the headline: one row per harness with a
 * share bar, its % of the window's cost, and its token total. Rows key their
 * color off the chart's own series scale (`colorVar`/`labelFor`) so a
 * harness reads the same hue here as in the daily chart's legend - the
 * dataviz skill's "color follows the entity" rule applied across two views
 * of the same window.
 */
export function UsageHarnessSplit(props: UsageHarnessSplitProps): ReactNode {
  if (props.rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" data-testid="usage-harness-split">
      {props.rows.map((row) => (
        <UsageHarnessSplitItem
          key={row.harnessId}
          row={row}
          scale={props.scale}
        />
      ))}
    </ul>
  );
}

function UsageHarnessSplitItem(props: {
  readonly row: UsageHarnessSplitRow;
  readonly scale: UsageSeriesScale;
}): ReactNode {
  const { row, scale } = props;
  const color = scale.colorVar(row.harnessId);
  const percentLabel = `${(row.shareOfCost * 100).toFixed(1)}%`;
  return (
    // Fluid rather than a fixed-width track. The row's fixed columns added
    // up to ~380px of non-shrinking content, and its container
    // (`SettingsModalContent`) is `overflow-x-hidden` - so once the pane got
    // narrower than that, the cost and token values were CLIPPED rather than
    // scrollable-to. The desktop shell's 960px minimum width leaves slack at
    // 100% text size, but rem-based columns outgrow a px-sized pane under
    // browser text-only zoom or an OS font-scaling setting, which is exactly
    // the case the fluid-sizing rule exists for. Now the label shrinks and
    // truncates, the value columns keep their aligned widths as minimums,
    // and the trailing group wraps instead of disappearing.
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid={`usage-harness-split-row-${row.harnessId}`}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="w-24 min-w-0 shrink truncate text-ui-sm text-foreground">
        {scale.labelFor(row.harnessId)}
      </span>
      <span
        className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${percentLabel} of cost`}
      >
        <span
          className={cn("block h-full rounded-full")}
          style={{
            width: `${String(Math.min(100, row.shareOfCost * 100))}%`,
            backgroundColor: color,
          }}
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
