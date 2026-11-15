import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import type { BotExchange } from "@/lib/bots/bot-exchanges";
import {
  exchangeLineKeyOf,
  exchangeLineRow,
  sameExchange,
} from "@/stores/chats/transcript-exchange-lines";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import {
  memoryLineKeyOf,
  memoryLineRow,
} from "@/stores/chats/transcript-memory-lines";
import {
  createTimedLineCollator,
  type TimedLineSpec,
} from "@/stores/chats/transcript-timed-lines";

/** Lays a surface's bot lines among its rows; see `createBotLineCollator`. */
export type BotLineCollator = (
  rows: readonly TranscriptListRow[],
  exchanges: ReadonlyArray<BotExchange>,
  changes: ReadonlyArray<BotMemoryChange>,
) => readonly TranscriptListRow[];

/** Something the bot did between the rows, drawn in a line of its kind. */
type BotLineEvent =
  | { readonly kind: "exchange"; readonly exchange: BotExchange }
  | { readonly kind: "memory"; readonly change: BotMemoryChange };

const BOT_LINE_SPEC: TimedLineSpec<BotLineEvent> = {
  timeOf,
  kindOf: (event) => event.kind,
  keyOf: lineKeyOf,
  sameRun: (before, after) =>
    before.length === after.length &&
    before.every((event, index) => sameEvent(event, after[index])),
  lineRowOf,
};

/**
 * A bot channel's (or thread's) rows with its bot's messages to other bots
 * (Tracy Bots, decision 174) and its changes to its memory (T373) drawn as
 * lines between them, by `createTimedLineCollator`'s rules over both kinds
 * at once: a run of one kind with no row and nothing of the other kind
 * between them is one line, placed by its first event's time.
 *
 * One pass, because a pass over one kind cannot see the other: laying the
 * exchanges first folds exchange, memory, exchange into one exchange line
 * with the change after it, and laying the changes first folds memory,
 * exchange, memory into one memory line the same way. An exchange and a
 * change at the same time draw the exchange first.
 *
 * A line's key is its first event's, so it keeps its place in the list as
 * its run grows. The two kinds are merged again only when `exchanges` or
 * `changes` is a new array, so a streamed token reads neither.
 */
export function createBotLineCollator(): BotLineCollator {
  const collate = createTimedLineCollator(BOT_LINE_SPEC);
  let lastExchanges: ReadonlyArray<BotExchange> | null = null;
  let lastChanges: ReadonlyArray<BotMemoryChange> | null = null;
  let events: ReadonlyArray<BotLineEvent> = [];
  return (rows, exchanges, changes) => {
    if (exchanges !== lastExchanges || changes !== lastChanges) {
      events = botLineEventsOf(exchanges, changes);
      lastExchanges = exchanges;
      lastChanges = changes;
    }
    return collate(rows, events);
  };
}

/**
 * Both kinds in one list, oldest first as each already is, an exchange
 * before a change made at the same time.
 */
function botLineEventsOf(
  exchanges: ReadonlyArray<BotExchange>,
  changes: ReadonlyArray<BotMemoryChange>,
): ReadonlyArray<BotLineEvent> {
  const events: BotLineEvent[] = [];
  let exchange = 0;
  let change = 0;
  while (exchange < exchanges.length || change < changes.length) {
    const exchangeNext =
      change === changes.length ||
      (exchange < exchanges.length &&
        exchanges[exchange].timestamp <= changes[change].at);
    if (exchangeNext) {
      events.push({ kind: "exchange", exchange: exchanges[exchange] });
      exchange += 1;
    } else {
      events.push({ kind: "memory", change: changes[change] });
      change += 1;
    }
  }
  return events;
}

function timeOf(event: BotLineEvent): number {
  return event.kind === "exchange" ? event.exchange.timestamp : event.change.at;
}

function lineKeyOf(run: ReadonlyArray<BotLineEvent>): string {
  const first = run[0];
  return first.kind === "exchange"
    ? exchangeLineKeyOf(first.exchange)
    : memoryLineKeyOf(first.change);
}

/** A change is never rewritten, so it draws alike while it is the same change. */
function sameEvent(before: BotLineEvent, after: BotLineEvent): boolean {
  if (before.kind === "exchange") {
    return (
      after.kind === "exchange" && sameExchange(before.exchange, after.exchange)
    );
  }
  return after.kind === "memory" && before.change.id === after.change.id;
}

function lineRowOf(run: ReadonlyArray<BotLineEvent>): TranscriptListRow {
  return run[0].kind === "exchange"
    ? exchangeLineRow(
        run.flatMap((event) =>
          event.kind === "exchange" ? [event.exchange] : [],
        ),
      )
    : memoryLineRow(
        run.flatMap((event) => (event.kind === "memory" ? [event.change] : [])),
      );
}
