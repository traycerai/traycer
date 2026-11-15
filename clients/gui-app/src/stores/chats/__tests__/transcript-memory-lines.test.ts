import { describe, expect, it } from "vitest";
import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import { makeMessageAt } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  channelRows,
  layout,
  windowedRows,
} from "@/stores/chats/__tests__/transcript-line-test-support";
import { createBotMemoryLineCollator } from "@/stores/chats/transcript-memory-lines";
import {
  transcriptListRows,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";

function changeAt(
  at: number,
  overrides: Partial<BotMemoryChange>,
): BotMemoryChange {
  return {
    id: `change-${at}`,
    at,
    action: "add",
    memory: "own",
    entryId: `entry-${at}`,
    threadId: null,
    ...overrides,
  };
}

function lineOf(row: TranscriptListRow) {
  if (row.kind !== "hydrated") throw new Error("a line is a hydrated row");
  const [segment] = row.model.segments;
  if (segment.kind !== "bot-memory-changes") {
    throw new Error("not a memory line");
  }
  return { row, segment };
}

describe("createBotMemoryLineCollator", () => {
  it("draws a run of changes with no row between them as one line placed among the rows", () => {
    const rows = channelRows(100, 400);
    const changes = [
      changeAt(200, { memory: "shared", entryId: "s1" }),
      changeAt(250, { memory: "own", entryId: "o1" }),
      changeAt(300, { memory: "shared", action: "remove", entryId: "s2" }),
    ];

    const merged = createBotMemoryLineCollator()(rows, changes);

    expect(layout(merged)).toEqual([
      "message-0",
      "bot-memory:change-200",
      "message-1",
    ]);
    const { row, segment } = lineOf(merged[1]);
    expect(row.ordinal).toBeNull();
    expect(row.model).toMatchObject({
      id: "bot-memory:change-200",
      role: "system",
      createdAt: 200,
    });
    expect(row.model.segments).toHaveLength(1);
    expect(segment).toEqual({
      id: "bot-memory:change-200:line",
      kind: "bot-memory-changes",
      groups: [
        {
          memory: "shared",
          added: 1,
          updated: 0,
          removed: 1,
          entryIds: ["s1", "s2"],
        },
        {
          memory: "own",
          added: 1,
          updated: 0,
          removed: 0,
          entryIds: ["o1"],
        },
      ],
      lastAt: 300,
    });
  });

  it("starts a fresh line for the changes after a row that closed the run", () => {
    const rows = channelRows(100, 300, 500);
    const changes = [changeAt(200, {}), changeAt(400, {}), changeAt(450, {})];

    const merged = createBotMemoryLineCollator()(rows, changes);

    expect(layout(merged)).toEqual([
      "message-0",
      "bot-memory:change-200",
      "message-1",
      "bot-memory:change-400",
      "message-2",
    ]);
    expect(lineOf(merged[1]).segment.groups[0]).toMatchObject({ added: 1 });
    expect(lineOf(merged[3]).segment.groups[0]).toMatchObject({ added: 2 });
  });

  it("folds a new change into the trailing line, which keeps its key and place", () => {
    const rows = channelRows(100);
    const before = [changeAt(200, {}), changeAt(210, { action: "update" })];
    const after = [...before, changeAt(220, { action: "remove" })];

    const collate = createBotMemoryLineCollator();
    const first = collate(rows, before);
    const second = collate(rows, after);

    expect(layout(first)).toEqual(["message-0", "bot-memory:change-200"]);
    expect(second[1].key).toBe(first[1].key);
    expect(lineOf(first[1]).segment).toMatchObject({
      groups: [{ added: 1, updated: 1, removed: 0 }],
      lastAt: 210,
    });
    expect(lineOf(second[1]).segment).toMatchObject({
      groups: [{ added: 1, updated: 1, removed: 1 }],
      lastAt: 220,
    });
  });

  it("puts changes older than every row in a line before the first row", () => {
    const rows = channelRows(300);

    expect(
      layout(createBotMemoryLineCollator()(rows, [changeAt(100, {})])),
    ).toEqual(["bot-memory:change-100", "message-0"]);
  });

  it("returns the same rows when there is no change", () => {
    const rows = channelRows(100, 200);

    expect(createBotMemoryLineCollator()(rows, [])).toBe(rows);
  });

  it("keeps the model of a line whose run is unchanged when a later run grows", () => {
    const rows = channelRows(100, 300, 500);
    const before = [changeAt(200, {}), changeAt(400, {})];
    const after = [...before, changeAt(450, {})];
    const collate = createBotMemoryLineCollator();
    const first = collate(rows, before);

    const second = collate(rows, after);

    expect(layout(second)).toEqual(layout(first));
    expect(second[1]).toBe(first[1]);
    expect(second[3]).not.toBe(first[3]);
    expect(lineOf(second[3]).segment.groups[0]).toMatchObject({ added: 2 });
  });

  it("keeps the earlier lines when a row arrives after the trailing run and closes it", () => {
    const changes = [
      changeAt(50, {}),
      changeAt(200, {}),
      changeAt(210, { action: "update" }),
    ];
    const collate = createBotMemoryLineCollator();
    const first = collate(channelRows(100), changes);

    const second = collate(channelRows(100, 300), changes);

    expect(layout(first)).toEqual([
      "bot-memory:change-50",
      "message-0",
      "bot-memory:change-200",
    ]);
    expect(layout(second)).toEqual([
      "bot-memory:change-50",
      "message-0",
      "bot-memory:change-200",
      "message-1",
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
  });

  it("places the lines again when the rows move with their count unchanged", () => {
    const changes = [changeAt(300, {})];
    const collate = createBotMemoryLineCollator();
    expect(layout(collate(channelRows(100, 400), changes))).toEqual([
      "message-0",
      "bot-memory:change-300",
      "message-1",
    ]);

    const slid = transcriptListRows({
      window: null,
      rendered: [makeMessageAt(1, "user", 400), makeMessageAt(2, "user", 500)],
      splitLongTurns: false,
    });

    expect(layout(collate(slid, changes))).toEqual([
      "bot-memory:change-300",
      "message-1",
      "message-2",
    ]);
  });
});

describe("createBotMemoryLineCollator over a windowed transcript", () => {
  it("withholds changes whose place is hidden by a placeholder, until the rows around them hydrate", () => {
    const changes = [
      changeAt(50, {}),
      changeAt(200, {}),
      changeAt(400, {}),
      changeAt(600, {}),
    ];

    const withheld = createBotMemoryLineCollator()(
      windowedRows([0, 2]),
      changes,
    );
    const hydrated = createBotMemoryLineCollator()(
      windowedRows([0, 1, 2]),
      changes,
    );

    expect(layout(withheld)).toEqual([
      "bot-memory:change-50",
      "message-0",
      "message-1",
      "message-2",
      "bot-memory:change-600",
    ]);
    expect(layout(hydrated)).toEqual([
      "bot-memory:change-50",
      "message-0",
      "bot-memory:change-200",
      "message-1",
      "bot-memory:change-400",
      "message-2",
      "bot-memory:change-600",
    ]);
  });

  it("withholds changes after the last row while a placeholder still stands before them", () => {
    const rows = windowedRows([0]);

    expect(
      layout(createBotMemoryLineCollator()(rows, [changeAt(700, {})])),
    ).toEqual(layout(rows));
  });
});
