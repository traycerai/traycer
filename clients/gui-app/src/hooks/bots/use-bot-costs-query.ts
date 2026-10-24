import { useMemo } from "react";
import type { BotThreadListResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";

/**
 * What a bot and its environment have cost (Tracy Bots, decision 43): the
 * bot's figure is its trunk's plus its threads', every member's turns, as
 * its bound host's `bot.thread.list` answers them; the environment's is the
 * sum of its bots' figures, each the same all-member figure. No figure per
 * person. `null` is "not known": the read has not answered, failed, or one
 * of the figures it adds up is not known - a bot bound to another host, or
 * to none, included, so a partial sum is never shown as the whole.
 */
export interface BotCosts {
  readonly botUsd: number | null;
  readonly trunkUsd: number | null;
  readonly environmentUsd: number | null;
}

/** A bot of the environment, as the cost sum needs it. */
export interface BotCostsEnvironmentBot {
  readonly botId: string;
  readonly boundHostId: string | null;
}

const NO_BOTS: ReadonlyArray<BotCostsEnvironmentBot> = [];

/**
 * The bot's figures from its thread listing, and the environment's from the
 * thread listing of every other bot of the environment, read through the
 * tab's host, which lists only the bots bound to it.
 */
export function useBotCostsQuery(
  client: HostClient<HostRpcRegistry> | null,
  args: {
    readonly botId: string;
    /** The tab's host: the one whose bots' listings can be read. */
    readonly hostId: string;
    /** The bot's thread listing; `undefined` while it is not read. */
    readonly threadList: BotThreadListResponse | undefined;
    /** Every bot of the bot's environment; `null` while the list is not read. */
    readonly environmentBots: ReadonlyArray<BotCostsEnvironmentBot> | null;
    readonly enabled: boolean;
  },
): BotCosts {
  const { botId, hostId, threadList, environmentBots, enabled } = args;
  const siblings = useMemo(
    () =>
      environmentBots === null
        ? null
        : environmentBots.filter((bot) => bot.botId !== botId),
    [botId, environmentBots],
  );
  const requests = useMemo(
    () =>
      (siblings ?? NO_BOTS)
        .filter((bot) => bot.boundHostId === hostId)
        .map((bot) => ({
          method: "bot.thread.list" as const,
          params: { botId: bot.botId },
        })),
    [siblings, hostId],
  );
  const results = useHostQueries<HostRpcRegistry, "bot.thread.list">({
    client,
    requests,
    cacheKeyIdentity: undefined,
    options: { enabled, refetchOnWindowFocus: false },
  });
  const botUsd = threadList === undefined ? null : botUsdOf(threadList);
  let environmentUsd: number | null =
    siblings !== null && siblings.length === requests.length ? botUsd : null;
  for (const result of results) {
    if (environmentUsd === null) break;
    const siblingUsd = result.data === undefined ? null : botUsdOf(result.data);
    environmentUsd = siblingUsd === null ? null : environmentUsd + siblingUsd;
  }
  return {
    botUsd,
    trunkUsd: threadList?.trunkCostUsd ?? null,
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
