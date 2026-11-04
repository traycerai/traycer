import {
  PROVIDER_DISPLAY_NAMES,
  TUI_HARNESS_ID_TO_PROVIDER_ID,
} from "@traycer/protocol/host/provider-schemas";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import { lastNCalendarDays } from "@/lib/usage-analytics/day-window";
import { formatDateRangeLabel } from "@/lib/usage-analytics/format-metric-value";
import { totalTokensForBucket } from "@/lib/usage-analytics/usage-chart-data";

export interface ShareUsageAgent {
  /** The harness id usage is recorded under (`claude`, `codex`, ...). */
  readonly id: string;
  readonly name: string;
  readonly tokens: number;
  /** This agent's share of the window's tokens, `0..1`. */
  readonly share: number;
}

/** What the share images say about a task's recent work. */
export interface ShareUsageFacts {
  /** "Oct 29 – Nov 4, 2026". */
  readonly rangeLabel: string;
  readonly totalTokens: number;
  readonly chatCount: number;
  /** Every day of the window, oldest first, with the tokens spent on it. */
  readonly days: ReadonlyArray<{
    readonly day: string;
    readonly tokens: number;
  }>;
  /** The agents that worked on the task, most tokens first. */
  readonly agents: ReadonlyArray<ShareUsageAgent>;
}

/**
 * The display name of a harness as usage records it. Usage keys harnesses by
 * their run id (`claude`), the provider list by provider id (`claude-code`);
 * either resolves through the protocol's own names, and an id it does not
 * know is shown as written.
 */
export function harnessDisplayName(harnessId: string): string {
  if (isRunHarnessId(harnessId)) {
    return PROVIDER_DISPLAY_NAMES[TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId]];
  }
  if (isProviderId(harnessId)) return PROVIDER_DISPLAY_NAMES[harnessId];
  return harnessId;
}

function isRunHarnessId(
  value: string,
): value is keyof typeof TUI_HARNESS_ID_TO_PROVIDER_ID {
  return Object.hasOwn(TUI_HARNESS_ID_TO_PROVIDER_ID, value);
}

function isProviderId(
  value: string,
): value is keyof typeof PROVIDER_DISPLAY_NAMES {
  return Object.hasOwn(PROVIDER_DISPLAY_NAMES, value);
}

export function shareUsageFacts(
  response: UsageSummaryResponse,
): ShareUsageFacts {
  const { summary } = response;
  const days = lastNCalendarDays(
    summary.window.windowDays,
    summary.window.timezone,
    summary.window.endAtExclusive - 1,
  );
  const tokensByDay = new Map<string, number>();
  const tokensByAgent = new Map<string, number>();
  for (const bucket of summary.buckets) {
    const tokens = totalTokensForBucket(bucket);
    tokensByDay.set(bucket.day, (tokensByDay.get(bucket.day) ?? 0) + tokens);
    tokensByAgent.set(
      bucket.harnessId,
      (tokensByAgent.get(bucket.harnessId) ?? 0) + tokens,
    );
  }
  const totalTokens = [...tokensByAgent.values()].reduce(
    (sum, tokens) => sum + tokens,
    0,
  );
  return {
    rangeLabel: formatDateRangeLabel(days),
    totalTokens,
    chatCount: summary.distinctChatCount,
    days: days.map((day) => ({ day, tokens: tokensByDay.get(day) ?? 0 })),
    agents: [...tokensByAgent.entries()]
      .map(([id, tokens]) => ({
        id,
        name: harnessDisplayName(id),
        tokens,
        share: totalTokens === 0 ? 0 : tokens / totalTokens,
      }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
