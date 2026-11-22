import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import { exchangePairsOf, type BotExchange } from "@/lib/bots/bot-exchanges";

const EXCHANGE_LINE_KEY_PREFIX = "bot-exchanges:";

/** Lays a surface's bot exchanges among its rows; see `createBotExchangeLineCollator`. */
export type BotExchangeLineCollator = (
  rows: readonly TranscriptListRow[],
  exchanges: ReadonlyArray<BotExchange>,
) => readonly TranscriptListRow[];

/** A line and the index of the row it goes before (`rows.length`: last). */
interface PlacedLine {
  readonly before: number;
  readonly line: TranscriptListRow;
}

/** A line as last drawn, and the run it was drawn from. */
interface DrawnLine {
  readonly run: ReadonlyArray<BotExchange>;
  readonly line: TranscriptListRow;
}

/**
 * A bot channel's (or thread's) rows with its bot's messages to other bots
 * between them, as Slack draws members joining a channel (Tracy Bots,
 * decision 174): a run of messages with no row of the list between them is
 * ONE line, placed by time among the rows. A row closes the run, and the next
 * message opens a fresh line; while a line is the last row, each new message
 * folds into it, because nothing has closed its run.
 *
 * `exchanges` are oldest first. A row is placed by `createdAt`, and a message
 * goes before the first row that came after it. The lines own no ordinal, so
 * hydration, the minimap and find, which read ordinals and roles, see none of
 * them.
 *
 * A placeholder's time is not known, so the messages between the last row
 * drawn before it and the next row drawn after it have no place yet: they are
 * left out until the rows around them hydrate, rather than collated across
 * rows nobody can see.
 *
 * A line's key is its first message's, so it keeps its place in the list as
 * the run grows.
 *
 * The collator remembers what it drew last. A streamed token changes a row's
 * body and no row's place, so while the rows keep their kinds and times and
 * `exchanges` is the same array, it lays the lines it already has back among
 * the new rows without reading a message. When the placement does move, a
 * line whose run is unchanged keeps its model, so the list redraws only the
 * lines that changed.
 */
export function createBotExchangeLineCollator(): BotExchangeLineCollator {
  let lastRows: readonly TranscriptListRow[] = [];
  let lastExchanges: ReadonlyArray<BotExchange> | null = null;
  let placed: readonly PlacedLine[] = [];
  let drawn = new Map<string, DrawnLine>();
  return (rows, exchanges) => {
    if (exchanges.length === 0) {
      lastExchanges = exchanges;
      lastRows = rows;
      placed = [];
      drawn = new Map();
      return rows;
    }
    if (exchanges !== lastExchanges || !sameBoundaries(lastRows, rows)) {
      const next = new Map<string, DrawnLine>();
      placed = placeRuns(rows, exchanges).map(({ before, run }) => {
        const line = lineFor(run, drawn);
        next.set(line.key, { run, line });
        return { before, line };
      });
      drawn = next;
      lastExchanges = exchanges;
    }
    lastRows = rows;
    return interleave(rows, placed);
  };
}

/** The rows sit where they sat: same count, kinds and times, body aside. */
function sameBoundaries(
  previous: readonly TranscriptListRow[],
  rows: readonly TranscriptListRow[],
): boolean {
  if (previous.length !== rows.length) return false;
  for (let index = 0; index < rows.length; index += 1) {
    const before = previous[index];
    const after = rows[index];
    if (before === after) continue;
    if (before.kind !== after.kind) return false;
    if (
      before.kind === "hydrated" &&
      after.kind === "hydrated" &&
      before.model.createdAt !== after.model.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function placeRuns(
  rows: readonly TranscriptListRow[],
  exchanges: ReadonlyArray<BotExchange>,
): Array<{ readonly before: number; readonly run: BotExchange[] }> {
  const runs: Array<{ readonly before: number; readonly run: BotExchange[] }> =
    [];
  let next = 0;
  let unplaceable = false;
  const takeRunBefore = (time: number): BotExchange[] => {
    const run: BotExchange[] = [];
    while (next < exchanges.length && exchanges[next].timestamp < time) {
      run.push(exchanges[next]);
      next += 1;
    }
    return run;
  };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "placeholder") {
      unplaceable = true;
      continue;
    }
    const run = takeRunBefore(row.model.createdAt);
    if (run.length > 0 && !unplaceable) runs.push({ before: index, run });
    unplaceable = false;
  }
  const trailing = takeRunBefore(Number.POSITIVE_INFINITY);
  if (trailing.length > 0 && !unplaceable) {
    runs.push({ before: rows.length, run: trailing });
  }
  return runs;
}

function interleave(
  rows: readonly TranscriptListRow[],
  placed: readonly PlacedLine[],
): readonly TranscriptListRow[] {
  if (placed.length === 0) return rows;
  const merged: TranscriptListRow[] = [];
  let line = 0;
  rows.forEach((row, index) => {
    while (line < placed.length && placed[line].before === index) {
      merged.push(placed[line].line);
      line += 1;
    }
    merged.push(row);
  });
  for (; line < placed.length; line += 1) merged.push(placed[line].line);
  return merged;
}

/** The line drawn last for the same run, or a fresh one. */
function lineFor(
  run: ReadonlyArray<BotExchange>,
  drawn: ReadonlyMap<string, DrawnLine>,
): TranscriptListRow {
  const previous = drawn.get(lineKeyOf(run));
  return previous !== undefined && sameRun(previous.run, run)
    ? previous.line
    : exchangeLineRow(run);
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
  const id = lineKeyOf(run);
  const last = run[run.length - 1];
  const model: ChatMessageModel = {
    id,
    role: "system",
    content: "",
    segments: [
      {
        id: `${id}:line`,
        kind: "bot-exchanges",
        pairs: exchangePairsOf(run),
        lastAt: last.timestamp,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: run[0].timestamp,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    runState: null,
    agentSenderInfo: null,
    agentMessage: null,
    sessionAnchor: null,
    steerBadge: null,
  };
  return { kind: "hydrated", key: id, ordinal: null, model, part: null };
}
