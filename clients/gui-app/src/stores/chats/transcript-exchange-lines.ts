import { exchangePairsOf, type BotExchange } from "@/lib/bots/bot-exchanges";
import { timedLineRow } from "@/stores/chats/transcript-timed-lines";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

const EXCHANGE_LINE_KEY_PREFIX = "bot-exchanges:";

/**
 * The key of the line a run of the bot's messages with other bots draws
 * (Tracy Bots, decision 174): its first message's, so the line keeps its
 * place in the list as the run grows.
 */
export function exchangeLineKeyOf(first: BotExchange): string {
  return `${EXCHANGE_LINE_KEY_PREFIX}${first.key}`;
}

/** What a line shows of a message: its other bot, and its time. */
export function sameExchange(before: BotExchange, after: BotExchange): boolean {
  return (
    before.key === after.key &&
    before.peerBotId === after.peerBotId &&
    before.timestamp === after.timestamp
  );
}

/** A run's line: each message's other bot, placed at the run's first time. */
export function exchangeLineRow(
  run: ReadonlyArray<BotExchange>,
): TranscriptListRow {
  const key = exchangeLineKeyOf(run[0]);
  return timedLineRow(
    key,
    {
      id: `${key}:line`,
      kind: "bot-exchanges",
      pairs: exchangePairsOf(run),
      lastAt: run[run.length - 1].timestamp,
    },
    run[0].timestamp,
  );
}
