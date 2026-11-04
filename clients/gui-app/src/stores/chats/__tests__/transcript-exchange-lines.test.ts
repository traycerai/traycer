import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { botExchangesOf, type BotExchange } from "@/lib/bots/bot-exchanges";
import {
  BOT_ID,
  DOCS_BOT_ID,
  RELEASE_BOT_ID,
  TRUNK_CHAT_ID,
  feedEvent,
} from "@/lib/bots/__tests__/bot-exchange-test-support";
import { makeMessageAt } from "@/components/chat/__tests__/chat-message-fixtures";
import { withBotExchangeLines } from "@/stores/chats/transcript-exchange-lines";
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
      }),
    ),
    BOT_ID,
    new Set([TRUNK_CHAT_ID]),
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

describe("withBotExchangeLines", () => {
  it("draws a run of exchanges with no row between them as one line placed among the rows", () => {
    const rows = channelRows(100, 400);
    const exchanges = exchangesWith(
      [RELEASE_BOT_ID, 200],
      [RELEASE_BOT_ID, 250],
      [RELEASE_BOT_ID, 300],
    );

    const merged = withBotExchangeLines(rows, exchanges);

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

    const merged = withBotExchangeLines(rows, exchanges);

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

    const first = withBotExchangeLines(rows, before);
    const second = withBotExchangeLines(rows, after);

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

    expect(layout(withBotExchangeLines(rows, exchanges))).toEqual([
      `bot-exchanges:${exchanges[0].key}`,
      "message-0",
    ]);
  });

  it("returns the same rows when the feed has no exchange", () => {
    const rows = channelRows(100, 200);

    expect(withBotExchangeLines(rows, [])).toBe(rows);
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

describe("withBotExchangeLines over a windowed transcript", () => {
  it("withholds exchanges whose place is hidden by a placeholder, until the rows around them hydrate", () => {
    // Rows at 100 and 500 are served; the row between them, at 300, is not.
    const exchanges = exchangesWith(
      [RELEASE_BOT_ID, 50],
      [RELEASE_BOT_ID, 200],
      [DOCS_BOT_ID, 400],
      [DOCS_BOT_ID, 600],
    );

    const withheld = withBotExchangeLines(windowedRows([0, 2]), exchanges);
    const hydrated = withBotExchangeLines(windowedRows([0, 1, 2]), exchanges);

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

    expect(layout(withBotExchangeLines(rows, exchanges))).toEqual(layout(rows));
  });
});
