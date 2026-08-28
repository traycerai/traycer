import type { ReactNode } from "react";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { UsageBreakdownRow } from "@/lib/usage-analytics/usage-breakdown";

export interface UsageBreakdownTableProps {
  readonly rows: readonly UsageBreakdownRow[];
}

/**
 * Harness/model breakdown for the selected window - always shows both cost
 * and tokens (not gated by the page's metric toggle) since this table is
 * also the dataviz relief channel for the chart's WARN-band contrast slots:
 * every exact value has to be reachable here without hovering anything.
 */
export function UsageBreakdownTable(
  props: UsageBreakdownTableProps,
): ReactNode {
  if (props.rows.length === 0) {
    return (
      <p
        className="px-1 text-ui-sm text-muted-foreground"
        data-testid="usage-breakdown-empty"
      >
        No usage in this window.
      </p>
    );
  }
  return (
    <table
      className="w-full border-collapse text-ui-sm"
      data-testid="usage-breakdown-table"
    >
      <thead>
        <tr className="border-b border-border/60 text-left text-ui-xs text-muted-foreground">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Harness
          </th>
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Model
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Turns
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Tokens
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr
            // Structural, not space-joined: a model name may itself contain
            // a space, and `["a b", "c"]` must not key the same as
            // `["a", "b c"]` or React can reuse the wrong row on an update.
            key={JSON.stringify([row.harnessId, row.model])}
            className="border-b border-border/40 last:border-b-0"
          >
            {/* `wrap-anywhere` on the two identifier cells: the wire allows
                64/255 characters, and one unbroken model id would otherwise
                set the auto-layout table's minimum width and push Turns,
                Tokens and Cost out of a Settings modal that hides horizontal
                overflow. Wrapping keeps every value on screen; truncating
                would hide the identifier instead. */}
            <td className="py-1.5 pr-3 wrap-anywhere text-foreground">
              {row.harnessId}
            </td>
            <td className="py-1.5 pr-3 wrap-anywhere text-muted-foreground">
              {row.model}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">
              {row.factCount}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">
              {row.tokens.toLocaleString()}
            </td>
            <td className="py-1.5 text-right tabular-nums font-medium text-foreground">
              {formatUsd(row.costUsd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
