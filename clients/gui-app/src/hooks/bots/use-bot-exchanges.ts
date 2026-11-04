import { useMemo } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { botExchangesOf, type BotExchange } from "@/lib/bots/bot-exchanges";

const NO_HOSTS: ReadonlyArray<string> = [];

/**
 * A bot's messages with other bots of its environment (Tracy Bots, decision
 * 174), from the bot's own Communication Graph feed: a bot is a task, so the
 * feed the office view reads for `botId` holds every message its trunk and
 * its threads' sessions sent or received, cloud history first and a team
 * environment's arm beside it. `null` until that history has been handed
 * over, so a channel draws no line from half of it.
 *
 * `channel` is what the channel itself draws: every exchange no listed
 * thread's session made. `ofThread` is what a thread draws: the exchanges its
 * own session made.
 */
export function useBotExchanges(input: {
  readonly botId: string;
  /** The tab's host, which relays the feed first. */
  readonly hostId: string;
  /** The host that runs the bot, whose log the rows come from; `null` for none. */
  readonly boundHostId: string | null;
  readonly trunkChatId: string;
  readonly threads: ReadonlyArray<BotThreadSummary>;
}): {
  /** Every exchange of the bot, oldest first; `null` while not loaded. */
  readonly all: ReadonlyArray<BotExchange> | null;
  readonly channel: ReadonlyArray<BotExchange> | null;
  readonly ofThread: (
    sessionChatId: string,
  ) => ReadonlyArray<BotExchange> | null;
} {
  const { botId, hostId, boundHostId, trunkChatId, threads } = input;
  const originHostIds = useMemo(
    () => (boundHostId === null ? NO_HOSTS : [boundHostId]),
    [boundHostId],
  );
  const snapshot = useCommGraphSnapshot(botId, originHostIds, hostId);
  const threadSessionIds = useMemo(
    () => new Set(threads.map((thread) => thread.sessionChatId)),
    [threads],
  );
  const all = useMemo(() => {
    if (!snapshot.initialHistoryCaughtUp) return null;
    const own = new Set(threadSessionIds).add(trunkChatId);
    return botExchangesOf(snapshot.events, botId, own);
  }, [
    botId,
    snapshot.events,
    snapshot.initialHistoryCaughtUp,
    threadSessionIds,
    trunkChatId,
  ]);
  const channel = useMemo(
    () =>
      all?.filter(
        (exchange) =>
          exchange.ownAgentId === null ||
          !threadSessionIds.has(exchange.ownAgentId),
      ) ?? null,
    [all, threadSessionIds],
  );
  const ofThread = useMemo(() => {
    const bySession = new Map<string, BotExchange[]>();
    for (const exchange of all ?? []) {
      if (exchange.ownAgentId === null) continue;
      const list = bySession.get(exchange.ownAgentId);
      if (list === undefined) bySession.set(exchange.ownAgentId, [exchange]);
      else list.push(exchange);
    }
    return (sessionChatId: string): ReadonlyArray<BotExchange> | null =>
      all === null ? null : (bySession.get(sessionChatId) ?? NO_EXCHANGES);
  }, [all]);
  return useMemo(() => ({ all, channel, ofThread }), [all, channel, ofThread]);
}

const NO_EXCHANGES: ReadonlyArray<BotExchange> = [];
