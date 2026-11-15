import { exchangePairsOf, type BotExchange } from "@/lib/bots/bot-exchanges";
import {
  createTimedLineCollator,
  timedLineRow,
  type TimedLineCollator,
} from "@/stores/chats/transcript-timed-lines";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

const EXCHANGE_LINE_KEY_PREFIX = "bot-exchanges:";

/** Lays a surface's bot exchanges among its rows; see `createBotExchangeLineCollator`. */
export type BotExchangeLineCollator = TimedLineCollator<BotExchange>;

/**
 * A bot channel's (or thread's) rows with its bot's messages to other bots
 * between them (Tracy Bots, decision 174), placed and collated by
 * `createTimedLineCollator`'s rules: a run of messages with no row between
 * them is one line, placed by each message's `timestamp`.
 *
 * A line's key is its first message's, so it keeps its place in the list as
 * the run grows.
 */
export function createBotExchangeLineCollator(): BotExchangeLineCollator {
  return createTimedLineCollator<BotExchange>({
    timeOf: (exchange) => exchange.timestamp,
    keyOf: lineKeyOf,
    sameRun,
    lineRowOf: exchangeLineRow,
  });
}

/** What a line shows of its run: each message's other bot, and the times. */
function sameRun(
  before: ReadonlyArray<BotExchange>,
  after: ReadonlyArray<BotExchange>,
): boolean {
  return (
    before.length === after.length &&
    before.every(
      (exchange, index) =>
        exchange.key === after[index].key &&
        exchange.peerBotId === after[index].peerBotId &&
        exchange.timestamp === after[index].timestamp,
    )
  );
}

function lineKeyOf(run: ReadonlyArray<BotExchange>): string {
  return `${EXCHANGE_LINE_KEY_PREFIX}${run[0].key}`;
}

function exchangeLineRow(run: ReadonlyArray<BotExchange>): TranscriptListRow {
  const key = lineKeyOf(run);
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
