import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import {
  buildUsageSummaryRequest,
  type UsageSummaryResponse,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import { USAGE_SUMMARY_RESPONSE_TIMEOUT_MS } from "@/lib/usage-analytics/usage-summary-timing";

/**
 * What a bot and its environment have cost (Tracy Bots, decision 43): the
 * bot's figure is its container's - the trunk and every thread's session -
 * the trunk's is its own chat's, and the environment's is the sum of its
 * bots'. No figure per person. `null` is "not known": the read has not
 * answered, failed, or (for the environment) one of its bots has not.
 */
export interface BotCosts {
  readonly botUsd: number | null;
  readonly trunkUsd: number | null;
  readonly environmentUsd: number | null;
}

/**
 * Reads `host.usage.summary` once per bot of the environment, each scoped
 * to the bot's container over its whole life, through the tab's host.
 */
export function useBotCostsQuery(
  client: HostClient<HostRpcRegistry> | null,
  args: {
    readonly botId: string;
    readonly trunkChatId: string;
    /** Every bot of the bot's environment, this one included. */
    readonly environmentBotIds: ReadonlyArray<string>;
    readonly enabled: boolean;
  },
): BotCosts {
  const { botId, trunkChatId, environmentBotIds, enabled } = args;
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
  const byBotId = new Map<string, UsageSummaryResponse>();
  botIds.forEach((id, index) => {
    const data = results[index]?.data;
    if (data !== undefined) byBotId.set(id, data);
  });
  return botCostsOf({ botId, trunkChatId, botIds, byBotId });
}

/** The three figures from the answers that are in. */
function botCostsOf(input: {
  readonly botId: string;
  readonly trunkChatId: string;
  readonly botIds: ReadonlyArray<string>;
  readonly byBotId: ReadonlyMap<string, UsageSummaryResponse>;
}): BotCosts {
  const own = input.byBotId.get(input.botId) ?? null;
  const trunkBucket =
    own?.summary.chatBuckets.find(
      (bucket) => bucket.chatId === input.trunkChatId,
    ) ?? null;
  let environmentUsd: number | null = 0;
  for (const id of input.botIds) {
    const answer = input.byBotId.get(id);
    if (answer === undefined) {
      environmentUsd = null;
      break;
    }
    environmentUsd += answer.summary.totals.knownCostUsd;
  }
  return {
    botUsd: own === null ? null : own.summary.totals.knownCostUsd,
    // A trunk with no turns in the window has no bucket: it cost nothing.
    trunkUsd: own === null ? null : (trunkBucket?.knownCostUsd ?? 0),
    environmentUsd,
  };
}
