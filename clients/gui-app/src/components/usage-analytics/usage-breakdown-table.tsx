import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type {
  UsageBreakdownRow,
  UsageCostProvenance,
} from "@/lib/usage-analytics/usage-breakdown";

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
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">
            Cost
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Provenance
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr
            key={`${row.harnessId} ${row.model}`}
            className="border-b border-border/40 last:border-b-0"
          >
            <td className="py-1.5 pr-3 text-foreground">{row.harnessId}</td>
            <td className="py-1.5 pr-3 text-muted-foreground">{row.model}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">
              {row.factCount}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">
              {row.tokens.toLocaleString()}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums font-medium text-foreground">
              {formatUsd(row.costUsd)}
            </td>
            <td className="py-1.5 text-right">
              <ProvenanceBadge provenance={row.provenance} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProvenanceBadge(props: {
  readonly provenance: UsageCostProvenance;
}): ReactNode {
  switch (props.provenance) {
    case "providerReported":
      return <Badge variant="secondary">Provider-reported</Badge>;
    case "modelPriced":
      return <Badge variant="outline">Modeled rate</Badge>;
    case "unpriced":
      return <Badge variant="ghost">Unpriced</Badge>;
  }
}
