import { useMemo } from "react";
import type { BotThreadListResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { buildUsageSummaryRequest } from "@/hooks/usage-analytics/use-usage-summary-query";
import { USAGE_SUMMARY_RESPONSE_TIMEOUT_MS } from "@/lib/usage-analytics/usage-summary-timing";

/**
 * What a bot and its environment have cost (Tracy Bots, decision 43): the
 * bot's figure is its trunk's plus its threads', every member's turns, as
 * its bound host's `bot.thread.list` answers them; the environment's is the
 * sum of its bots' as the person's usage records them. No figure per person.
 * `null` is "not known": the read has not answered, failed, or one of the
 * figures it adds up is not known.
 */
export interface BotCosts {
  readonly botUsd: number | null;
  readonly trunkUsd: number | null;
  readonly environmentUsd: number | null;
}

/**
 * The bot's figures from its thread listing, and the environment's from
 * `host.usage.summary` once per bot of the environment, each scoped to the
 * bot's container over its whole life, through the tab's host.
 */
export function useBotCostsQuery(
  client: HostClient<HostRpcRegistry> | null,
  args: {
    readonly botId: string;
    /** The bot's thread listing; `undefined` while it is not read. */
    readonly threadList: BotThreadListResponse | undefined;
    /** Every bot of the bot's environment, this one included. */
    readonly environmentBotIds: ReadonlyArray<string>;
    readonly enabled: boolean;
  },
): BotCosts {
  const { botId, threadList, environmentBotIds, enabled } = args;
  const botIds = useMemo(
    () =>
      environmentBotIds.includes(botId)
        ? environmentBotIds
        : [botId, ...environmentBotIds],
    [botId, environmentBotIds],
  );
  const requests = useMemo(
    () =>
      botIds.map((id) => ({
        method: "host.usage.summary" as const,
        params: buildUsageSummaryRequest({
          windowDays: 30,
          epicId: id,
          window: "epic",
          // A bot's surface has not been given the verdict-less cohort, so
          // the host keeps picking the reader, as the task usage dialog does.
          plane: null,
        }),
      })),
    [botIds],
  );
  const results = useHostQueries<HostRpcRegistry, "host.usage.summary">({
    client,
    requests,
    cacheKeyIdentity: undefined,
    responseTimeoutMs: USAGE_SUMMARY_RESPONSE_TIMEOUT_MS,
    options: { enabled, refetchOnWindowFocus: false },
  });
  let environmentUsd: number | null = 0;
  for (const result of results) {
    if (result.data === undefined) {
      environmentUsd = null;
      break;
    }
    environmentUsd += result.data.summary.totals.knownCostUsd;
  }
  const trunkUsd = threadList?.trunkCostUsd ?? null;
  return {
    botUsd: threadList === undefined ? null : botUsdOf(threadList),
    trunkUsd,
    environmentUsd,
  };
}

/** The trunk's figure plus every thread's; unknown when any of them is. */
function botUsdOf(threadList: BotThreadListResponse): number | null {
  let total = threadList.trunkCostUsd;
  for (const thread of threadList.threads) {
    if (total === null || thread.costUsd === null) return null;
    total += thread.costUsd;
  }
  return total;
}
