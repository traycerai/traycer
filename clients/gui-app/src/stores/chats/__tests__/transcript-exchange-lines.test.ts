import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { botExchangesOf, type BotExchange } from "@/lib/bots/bot-exchanges";
import {
  BOT_ID,
  DOCS_BOT_ID,
  RELEASE_BOT_ID,
  SENT_MIRROR,
  TRUNK_CHAT_ID,
  feedEvent,
} from "@/lib/bots/__tests__/bot-exchange-test-support";
import { makeMessageAt } from "@/components/chat/__tests__/chat-message-fixtures";
import { createBotExchangeLineCollator } from "@/stores/chats/transcript-exchange-lines";
import {
  transcriptListRows,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/** The channel's rows as the real list builder makes them on the legacy line. */
function channelRows(
  ...createdAts: ReadonlyArray<number>
): readonly TranscriptListRow[] {
  return transcriptListRows({
    window: null,
    rendered: createdAts.map((createdAt, index) =>
      makeMessageAt(index, "user", createdAt),
    ),
    splitLongTurns: false,
  });
}

/** The bot's exchanges with `peer` at each time, classified from real feed rows. */
function exchangesWith(
  ...sends: ReadonlyArray<readonly [peer: string, timestamp: number]>
): ReadonlyArray<BotExchange> {
  return botExchangesOf(
    sends.map(([peer, timestamp], index) =>
      feedEvent({
        id: index + 1,
        kind: "a2a_message",
        timestamp,
        sender: TRUNK_CHAT_ID,
        receiver: `trunk-${peer}`,
        text: `to ${peer} at ${timestamp}`,
        responseId: `r-${index}`,
        inReplyTo: null,
        peerEpicId: peer,
        origin: SENT_MIRROR,
      }),
    ),
    BOT_ID,
  );
}

/** Each row as `message-<n>` or the line's key, in list order. */
function layout(rows: readonly TranscriptListRow[]): ReadonlyArray<string> {
  return rows.map((row) => row.key);
}

function lineOf(row: TranscriptListRow) {
  if (row.kind !== "hydrated") throw new Error("a line is a hydrated row");
  const [segment] = row.model.segments;
  if (segment.kind !== "bot-exchanges") {
    throw new Error("not an exchange line");
  }
  return { row, segment };
}

describe("createBotExchangeLineCollator", () => {
  it("draws a run of exchanges with no row between them as one line placed among the rows", () => {
    const rows = channelRows(100, 400);
    const exchanges = exchangesWith(
      [RELEASE_BOT_ID, 200],
      [RELEASE_BOT_ID, 250],
      [RELEASE_BOT_ID, 300],
    );

    const merged = createBotExchangeLineCollator()(rows, exchanges);

    expect(layout(merged)).toEqual([
      "message-0",
      `bot-exchanges:${exchanges[0].key}`,
      "message-1",
    ]);
    const { row, segment } = lineOf(merged[1]);
    expect(row.ordinal).toBeNull();
    expect(row.model.role).toBe("system");
    expect(segment.pairs).toEqual([{ peerBotId: RELEASE_BOT_ID, count: 3 }]);
    expect(segment.lastAt).toBe(300);
  });

  it("starts a fresh line for the exchanges after a row that closed the run", () => {
    const rows = channelRows(100, 300, 500);
    const exchanges = exchangesWith(
      [RELEASE_BOT_ID, 200],
      [RELEASE_BOT_ID, 400],
      [DOCS_BOT_ID, 450],
    );

    const merged = createBotExchangeLineCollator()(rows, exchanges);

    expect(layout(merged)).toEqual([
      "message-0",
      `bot-exchanges:${exchanges[0].key}`,
      "message-1",
      `bot-exchanges:${exchanges[1].key}`,
      "message-2",
    ]);
    expect(lineOf(merged[1]).segment.pairs).toEqual([
      { peerBotId: RELEASE_BOT_ID, count: 1 },
    ]);
    expect(lineOf(merged[3]).segment.pairs).toEqual([
      { peerBotId: RELEASE_BOT_ID, count: 1 },
      { peerBotId: DOCS_BOT_ID, count: 1 },
    ]);
  });

  it("folds a new exchange into the trailing line, which keeps its place in the list", () => {
    const rows = channelRows(100);
    const before = exchangesWith([RELEASE_BOT_ID, 200], [DOCS_BOT_ID, 210]);
    const after = exchangesWith(
      [RELEASE_BOT_ID, 200],
      [DOCS_BOT_ID, 210],
      [RELEASE_BOT_ID, 220],
    );

    const collate = createBotExchangeLineCollator();
    const first = collate(rows, before);
    const second = collate(rows, after);

    expect(layout(first)).toEqual([
      "message-0",
      `bot-exchanges:${before[0].key}`,
    ]);
    expect(second[1].key).toBe(first[1].key);
    expect(lineOf(first[1]).segment.pairs).toEqual([
      { peerBotId: RELEASE_BOT_ID, count: 1 },
      { peerBotId: DOCS_BOT_ID, count: 1 },
    ]);
    expect(lineOf(second[1]).segment).toMatchObject({
      pairs: [
        { peerBotId: RELEASE_BOT_ID, count: 2 },
        { peerBotId: DOCS_BOT_ID, count: 1 },
      ],
      lastAt: 220,
    });
  });

  it("puts exchanges older than every row in a line before the first row", () => {
    const rows = channelRows(300);
    const exchanges = exchangesWith([DOCS_BOT_ID, 100]);

    expect(layout(createBotExchangeLineCollator()(rows, exchanges))).toEqual([
      `bot-exchanges:${exchanges[0].key}`,
      "message-0",
    ]);
  });

  it("returns the same rows when the feed has no exchange", () => {
    const rows = channelRows(100, 200);

    expect(createBotExchangeLineCollator()(rows, [])).toBe(rows);
  });
});

/** `exchanges`, and how many of its elements have been read through the proxy. */
function countingReads(exchanges: ReadonlyArray<BotExchange>): {
  readonly exchanges: ReadonlyArray<BotExchange>;
  readonly reads: () => number;
  readonly reset: () => void;
} {
  let reads = 0;
  const proxy = new Proxy(exchanges, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      const element: unknown = Reflect.get(target, property, receiver);
      return element;
    },
  });
  return {
    exchanges: proxy,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

function withContent(
  rows: readonly TranscriptListRow[],
  index: number,
  content: string,
): readonly TranscriptListRow[] {
  return rows.map((row, at) =>
    at === index && row.kind === "hydrated"
      ? { ...row, model: { ...row.model, content } }
      : row,
  );
}

describe("createBotExchangeLineCollator across updates", () => {
  it("lays the lines it has among rows whose body alone changed, reading no message", () => {
    const rows = channelRows(100, 400);
    const counted = countingReads(
      exchangesWith([RELEASE_BOT_ID, 200], [DOCS_BOT_ID, 250]),
    );
    const collate = createBotExchangeLineCollator();
    const first = collate(rows, counted.exchanges);
    expect(counted.reads()).toBeGreaterThan(0);
    counted.reset();

    const streamed = collate(
      withContent(rows, 1, "a longer body"),
      counted.exchanges,
    );

    expect(counted.reads()).toBe(0);
    expect(layout(streamed)).toEqual(layout(first));
    expect(streamed[1]).toBe(first[1]);
    expect(streamed[2]).toMatchObject({ model: { content: "a longer body" } });
  });

  it("places the lines again when the rows move with their count unchanged, as a window sliding by one does", () => {
    const exchanges = exchangesWith([RELEASE_BOT_ID, 300]);
    const collate = createBotExchangeLineCollator();
    const line = `bot-exchanges:${exchanges[0].key}`;
    expect(layout(collate(channelRows(100, 400), exchanges))).toEqual([
      "message-0",
      line,
      "message-1",
    ]);

    const slid = transcriptListRows({
      window: null,
      rendered: [makeMessageAt(1, "user", 400), makeMessageAt(2, "user", 500)],
      splitLongTurns: false,
    });

    expect(layout(collate(slid, exchanges))).toEqual([
      line,
      "message-1",
      "message-2",
    ]);
  });

  it("redraws only the line whose run changed when a new exchange lands in a later run", () => {
    const rows = channelRows(100, 300, 500);
    const before = exchangesWith([RELEASE_BOT_ID, 200], [RELEASE_BOT_ID, 400]);
    const after = exchangesWith(
      [RELEASE_BOT_ID, 200],
      [RELEASE_BOT_ID, 400],
      [RELEASE_BOT_ID, 450],
    );
    const collate = createBotExchangeLineCollator();
    const first = collate(rows, before);

    const second = collate(rows, after);

    expect(layout(second)).toEqual(layout(first));
    expect(second[1]).toBe(first[1]);
    expect(second[3]).not.toBe(first[3]);
    expect(lineOf(first[3]).segment.pairs).toEqual([
      { peerBotId: RELEASE_BOT_ID, count: 1 },
    ]);
    expect(lineOf(second[3]).segment.pairs).toEqual([
      { peerBotId: RELEASE_BOT_ID, count: 2 },
    ]);
  });

  it("keeps the earlier lines when a row arrives after the trailing run and closes it", () => {
    const exchanges = exchangesWith(
      [DOCS_BOT_ID, 50],
      [RELEASE_BOT_ID, 200],
      [RELEASE_BOT_ID, 210],
    );
    const collate = createBotExchangeLineCollator();
    const first = collate(channelRows(100), exchanges);

    const second = collate(channelRows(100, 300), exchanges);

    expect(layout(first)).toEqual([
      `bot-exchanges:${exchanges[0].key}`,
      "message-0",
      `bot-exchanges:${exchanges[1].key}`,
    ]);
    expect(layout(second)).toEqual([
      `bot-exchanges:${exchanges[0].key}`,
      "message-0",
      `bot-exchanges:${exchanges[1].key}`,
      "message-1",
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
  });
});

function skeletonEntry(rowId: string): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000,
    role: "user",
    byteLength: 32,
    bodyDigest: `d-${rowId}`,
  };
}

/** A window of `ids.length` rows of which only those at `hydrated` are served. */
function windowOver(
  ids: ReadonlyArray<string>,
  hydrated: ReadonlyArray<number>,
): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    rowCount: ids.length,
    skeleton: ids.map(skeletonEntry),
    skeletonComplete: true,
    skeletonStreamCoveredThrough: ids.length,
    indexRevisionRebuilding: false,
    spans: hydrated.map((ordinal) => ({
      fromOrdinal: ordinal,
      rowIds: [ids[ordinal]],
      messageIds: [],
      eventIds: [],
      rowContext: {},
      contextBytes: 0,
    })),
  };
}

function windowedRows(
  hydrated: ReadonlyArray<number>,
): readonly TranscriptListRow[] {
  const ids = ["message-0", "message-1", "message-2"];
  return transcriptListRows({
    window: windowOver(ids, hydrated),
    rendered: hydrated.map((ordinal) =>
      makeMessageAt(ordinal, "user", 100 + ordinal * 200),
    ),
    splitLongTurns: false,
  });
}

describe("createBotExchangeLineCollator over a windowed transcript", () => {
  it("withholds exchanges whose place is hidden by a placeholder, until the rows around them hydrate", () => {
    // Rows at 100 and 500 are served; the row between them, at 300, is not.
    const exchanges = exchangesWith(
      [RELEASE_BOT_ID, 50],
      [RELEASE_BOT_ID, 200],
      [DOCS_BOT_ID, 400],
      [DOCS_BOT_ID, 600],
    );

    const withheld = createBotExchangeLineCollator()(
      windowedRows([0, 2]),
      exchanges,
    );
    const hydrated = createBotExchangeLineCollator()(
      windowedRows([0, 1, 2]),
      exchanges,
    );

    expect(layout(withheld)).toEqual([
      `bot-exchanges:${exchanges[0].key}`,
      "message-0",
      "message-1",
      "message-2",
      `bot-exchanges:${exchanges[3].key}`,
    ]);
    expect(layout(hydrated)).toEqual([
      `bot-exchanges:${exchanges[0].key}`,
      "message-0",
      `bot-exchanges:${exchanges[1].key}`,
      "message-1",
      `bot-exchanges:${exchanges[2].key}`,
      "message-2",
      `bot-exchanges:${exchanges[3].key}`,
    ]);
  });

  it("withholds exchanges after the last row while a placeholder still stands before them", () => {
    const rows = windowedRows([0]);
    const exchanges = exchangesWith([RELEASE_BOT_ID, 700]);

    expect(layout(createBotExchangeLineCollator()(rows, exchanges))).toEqual(
      layout(rows),
    );
  });
});
