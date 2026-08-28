import type { ReactNode } from "react";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import { sumTokenTotals } from "@/lib/usage-analytics/usage-chart-data";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import { useEpicTreeNode } from "@/lib/epic-selectors";

type UsageChatBucket = UsageSummaryResponse["summary"]["chatBuckets"][number];

export interface UsageChatBreakdownProps {
  readonly rows: readonly UsageChatBucket[];
}

/**
 * By-chat/agent breakdown for the epic-scoped panel, as a real table
 * (2026-08-11 feedback round) with the same column styling as
 * `UsageBreakdownTable`. Titles are joined CLIENT-SIDE from the open epic's
 * own tree projection (`useEpicTreeNode`) - the summary only carries
 * `chatId`, and this is the one place in the app that already knows every
 * node's title, chat or A2A child agent alike (an A2A child agent is its
 * own chat, so this list doubles as the by-agent view with no separate wire
 * shape).
 */
export function UsageChatBreakdown(props: UsageChatBreakdownProps): ReactNode {
  if (props.rows.length === 0) {
    return (
      <p
        className="px-1 text-ui-sm text-muted-foreground"
        data-testid="usage-chat-breakdown-empty"
      >
        No chats with usage in this window.
      </p>
    );
  }
  const sorted = [...props.rows].sort(
    (a, b) => b.knownCostUsd - a.knownCostUsd,
  );
  return (
    <table
      className="w-full border-collapse text-ui-sm"
      data-testid="usage-chat-breakdown"
    >
      <thead>
        <tr className="border-b border-border/60 text-left text-ui-xs text-muted-foreground">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Chat / agent
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
        {sorted.map((row) => (
          <UsageChatBreakdownRow key={row.chatId} row={row} />
        ))}
      </tbody>
    </table>
  );
}

function UsageChatBreakdownRow(props: {
  readonly row: UsageChatBucket;
}): ReactNode {
  const { row } = props;
  const node = useEpicTreeNode(row.chatId);
  const title = node?.title ?? row.chatId;
  const tokens = sumTokenTotals(row.tokens);
  return (
    <tr
      className="border-b border-border/40 last:border-b-0"
      data-testid={`usage-chat-breakdown-row-${row.chatId}`}
    >
      {/* `wrap-anywhere`, matching the other breakdown tables' identifier
          cells: a fallback chatId (or a long unbroken title) must not set
          the auto-layout table's minimum width and push Tokens/Cost out of
          the dialog, and truncating would hide the identifier instead. */}
      <td className="py-1.5 pr-3 wrap-anywhere text-foreground">{title}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
        {tokens.toLocaleString()}
      </td>
      <td className="py-1.5 text-right tabular-nums font-medium text-foreground">
        {formatUsd(row.knownCostUsd)}
      </td>
    </tr>
  );
}
