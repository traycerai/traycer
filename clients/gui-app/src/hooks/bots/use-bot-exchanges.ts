import { useMemo } from "react";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { botExchangesOf, type BotExchange } from "@/lib/bots/bot-exchanges";

const NO_HOSTS: ReadonlyArray<string> = [];
const NO_EXCHANGES: ReadonlyArray<BotExchange> = [];

/**
 * A bot's messages with other bots of its environment (Tracy Bots, decision
 * 174), from the bot's own Communication Graph feed: a bot is a task, so the
 * feed the office view reads for `botId` holds every message its trunk and
 * its threads' sessions sent or received, cloud history first and each team
 * environment's arm beside it. `null` until every one of those sources has
 * handed over its history, so a surface draws no line from part of it.
 *
 * Each message is placed by the bot's session at its end of it: `channel` is
 * the trunk's, `ofSession` a thread session's. A message of a session that is
 * neither (a thread's earlier session, before it was resumed) is drawn on no
 * surface, and is still in `all`, which a pair's log reads.
 */
export function useBotExchanges(input: {
  readonly botId: string;
  /** The tab's host, which relays the feed first. */
  readonly hostId: string;
  /** The host that runs the bot, whose log the rows come from; `null` for none. */
  readonly boundHostId: string | null;
  readonly trunkChatId: string;
}): {
  /** Every exchange of the bot, oldest first; `null` while not loaded. */
  readonly all: ReadonlyArray<BotExchange> | null;
  readonly channel: ReadonlyArray<BotExchange> | null;
  readonly ofSession: (
    sessionChatId: string,
  ) => ReadonlyArray<BotExchange> | null;
} {
  const { botId, hostId, boundHostId, trunkChatId } = input;
  const originHostIds = useMemo(
    () => (boundHostId === null ? NO_HOSTS : [boundHostId]),
    [boundHostId],
  );
  const snapshot = useCommGraphSnapshot(botId, originHostIds, hostId);
  const all = useMemo(
    () =>
      snapshot.initialHistoryCaughtUp
        ? botExchangesOf(snapshot.events, botId)
        : null,
    [botId, snapshot.events, snapshot.initialHistoryCaughtUp],
  );
  return useMemo(() => {
    const bySession = new Map<string, BotExchange[]>();
    for (const exchange of all ?? NO_EXCHANGES) {
      if (exchange.ownAgentId === null) continue;
      const list = bySession.get(exchange.ownAgentId);
      if (list === undefined) bySession.set(exchange.ownAgentId, [exchange]);
      else list.push(exchange);
    }
    const ofSession = (
      sessionChatId: string,
    ): ReadonlyArray<BotExchange> | null =>
      all === null ? null : (bySession.get(sessionChatId) ?? NO_EXCHANGES);
    return { all, channel: ofSession(trunkChatId), ofSession };
  }, [all, trunkChatId]);
}
