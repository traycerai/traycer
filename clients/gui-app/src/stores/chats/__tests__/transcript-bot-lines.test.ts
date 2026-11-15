import { describe, expect, it } from "vitest";
import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import { botExchangesOf, type BotExchange } from "@/lib/bots/bot-exchanges";
import {
  BOT_ID,
  RELEASE_BOT_ID,
  SENT_MIRROR,
  TRUNK_CHAT_ID,
  feedEvent,
} from "@/lib/bots/__tests__/bot-exchange-test-support";
import {
  channelRows,
  layout,
} from "@/stores/chats/__tests__/transcript-line-test-support";
import { createBotLineCollator } from "@/stores/chats/transcript-bot-lines";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

function exchangesAt(
  ...times: ReadonlyArray<number>
): ReadonlyArray<BotExchange> {
  return botExchangesOf(
    times.map((timestamp, index) =>
      feedEvent({
        id: index + 1,
        kind: "a2a_message",
        timestamp,
        sender: TRUNK_CHAT_ID,
        receiver: `trunk-${RELEASE_BOT_ID}`,
        text: `to release at ${timestamp}`,
        responseId: `r-${index}`,
        inReplyTo: null,
        peerEpicId: RELEASE_BOT_ID,
        origin: SENT_MIRROR,
      }),
    ),
    BOT_ID,
  );
}

function changesAt(
  ...times: ReadonlyArray<number>
): ReadonlyArray<BotMemoryChange> {
  return times.map((at) => ({
    id: `change-${at}`,
    at,
    action: "add",
    memory: "own",
    entryId: `entry-${at}`,
    threadId: null,
  }));
}

function lastAtOf(row: TranscriptListRow): number {
  if (row.kind !== "hydrated") throw new Error("a line is a hydrated row");
  const [segment] = row.model.segments;
  if (
    segment.kind !== "bot-exchanges" &&
    segment.kind !== "bot-memory-changes"
  ) {
    throw new Error("not a bot line");
  }
  return segment.lastAt;
}

describe("createBotLineCollator", () => {
  it("draws exchange, memory, exchange between two messages in time order, each line with its own run's time", () => {
    const rows = channelRows(1000, 3000);
    const exchanges = exchangesAt(1500, 2500);
    const changes = changesAt(2000);

    const merged = createBotLineCollator()(rows, exchanges, changes);

    expect(layout(merged)).toEqual([
      "message-0",
      `bot-exchanges:${exchanges[0].key}`,
      "bot-memory:change-2000",
      `bot-exchanges:${exchanges[1].key}`,
      "message-1",
    ]);
    expect(merged.slice(1, 4).map(lastAtOf)).toEqual([1500, 2000, 2500]);
  });

  it("draws memory, exchange, memory in time order", () => {
    const exchanges = exchangesAt(2000);
    const merged = createBotLineCollator()(
      channelRows(1000, 4000),
      exchanges,
      changesAt(1500, 2500),
    );

    expect(layout(merged)).toEqual([
      "message-0",
      "bot-memory:change-1500",
      `bot-exchanges:${exchanges[0].key}`,
      "bot-memory:change-2500",
      "message-1",
    ]);
  });

  it("puts the exchange line first when an exchange and a change share a time", () => {
    const exchanges = exchangesAt(2000);
    const merged = createBotLineCollator()(
      channelRows(1000, 3000),
      exchanges,
      changesAt(2000),
    );

    expect(layout(merged)).toEqual([
      "message-0",
      `bot-exchanges:${exchanges[0].key}`,
      "bot-memory:change-2000",
      "message-1",
    ]);
  });

  it("folds a new exchange into a trailing exchange line, opens its own line for a later change, and a later exchange opens a new exchange line", () => {
    const rows = channelRows(1000);
    const collate = createBotLineCollator();
    const firstExchanges = exchangesAt(1500);
    const first = collate(rows, firstExchanges, []);

    const grown = exchangesAt(1500, 1600);
    const second = collate(rows, grown, []);
    const changes = changesAt(1700);
    const third = collate(rows, grown, changes);
    const later = exchangesAt(1500, 1600, 1800);
    const fourth = collate(rows, later, changes);

    expect(layout(first)).toEqual([
      "message-0",
      `bot-exchanges:${grown[0].key}`,
    ]);
    expect(layout(second)).toEqual(layout(first));
    expect(lastAtOf(second[1])).toBe(1600);
    expect(layout(third)).toEqual([
      "message-0",
      `bot-exchanges:${grown[0].key}`,
      "bot-memory:change-1700",
    ]);
    expect(layout(fourth)).toEqual([
      "message-0",
      `bot-exchanges:${grown[0].key}`,
      "bot-memory:change-1700",
      `bot-exchanges:${later[2].key}`,
    ]);
    expect(lastAtOf(fourth[1])).toBe(1600);
    expect(lastAtOf(fourth[3])).toBe(1800);
  });

  it("returns the identical lines for the same arrays and unchanged row boundaries", () => {
    const exchanges = exchangesAt(1500);
    const changes = changesAt(2000);
    const collate = createBotLineCollator();
    const first = collate(channelRows(1000, 3000), exchanges, changes);
    const rewritten = channelRows(1000, 3000).map((row, index) =>
      index === 1 && row.kind === "hydrated"
        ? { ...row, model: { ...row.model, content: "a longer body" } }
        : row,
    );

    const second = collate(rewritten, exchanges, changes);

    expect(layout(second)).toEqual(layout(first));
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second[3]).toMatchObject({ model: { content: "a longer body" } });
  });

  it("returns the rows themselves when there are neither exchanges nor changes", () => {
    const rows = channelRows(1000, 2000);

    expect(createBotLineCollator()(rows, [], [])).toBe(rows);
  });
});
