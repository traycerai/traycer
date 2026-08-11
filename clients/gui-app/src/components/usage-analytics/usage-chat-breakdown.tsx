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
 * By-chat/agent breakdown for the epic-scoped panel. Titles are joined
 * CLIENT-SIDE from the open epic's own tree projection (`useEpicTreeNode`) -
 * the summary only carries `chatId`, and this is the one place in the app
 * that already knows every node's title, chat or A2A child agent alike (an
 * A2A child agent is its own chat, so this list doubles as the by-agent
 * view with no separate wire shape).
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
    <ul className="flex flex-col gap-1.5" data-testid="usage-chat-breakdown">
      {sorted.map((row) => (
        <UsageChatBreakdownRow key={row.chatId} row={row} />
      ))}
    </ul>
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
    <li
      className="flex items-center gap-3 text-ui-sm"
      data-testid={`usage-chat-breakdown-row-${row.chatId}`}
    >
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      <span className="shrink-0 tabular-nums text-ui-xs text-muted-foreground">
        {tokens.toLocaleString()}
      </span>
      {/* `min-w-16`, not `w-16`: the column still aligns at the common
          case's width, but a wider figure ("$1,234.56") grows instead of
          overflowing its box. */}
      <span className="min-w-16 shrink-0 text-right tabular-nums font-medium text-foreground">
        {formatUsd(row.knownCostUsd)}
      </span>
    </li>
  );
}
