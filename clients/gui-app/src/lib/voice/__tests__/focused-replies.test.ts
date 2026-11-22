import { describe, expect, it } from "vitest";
import type { BotQuestionSettlement } from "@traycer/protocol/persistence/epic/messages";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  baselineReplyWatchExcept,
  createReplyWatchMemory,
  takeNewBotReplies,
  type ReplyRow,
  type ReplyWatchMemory,
} from "../focused-replies";

/** The snapshot a call joins an existing thread on: all of it is history. */
function baselineAsHistory(
  memory: ReplyWatchMemory,
  rows: ReadonlyArray<ReplyRow>,
): void {
  baselineReplyWatchExcept(memory, rows, () => false);
}

function textBlock(text: string): OpenTextBlock {
  return {
    blockId: `block-${text}`,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    type: "text",
    text,
    providerNotice: null,
  };
}

function botRow(
  messageId: string,
  timestamp: number,
  blocks: OpenTextBlock[],
): ReplyRow {
  return { role: "assistant", messageId, timestamp, blocks };
}

function userRow(messageId: string, timestamp: number): ReplyRow {
  return { role: "user", messageId, timestamp };
}

describe("takeNewBotReplies", () => {
  it("returns only new bot rows with prose, joins their text blocks, and marks every row seen", () => {
    const history = botRow("old", 10, [textBlock("history")]);
    const memory = createReplyWatchMemory();
    baselineAsHistory(memory, [history]);
    const rows: ReadonlyArray<ReplyRow> = [
      history,
      userRow("u1", 20),
      botRow("a1", 30, [textBlock("Yes."), textBlock("Merged.")]),
      botRow("a2", 40, [textBlock("   ")]),
    ];

    expect(takeNewBotReplies(rows, memory)).toEqual([
      { messageId: "a1", text: "Yes.\n\nMerged." },
    ]);
    expect([...memory.seen].sort()).toEqual(["a1", "a2", "old", "u1"]);
    expect(takeNewBotReplies(rows, memory)).toEqual([]);
  });

  it("treats a row hydrated from before the baseline as history, and speaks a newer one once", () => {
    const memory = createReplyWatchMemory();
    baselineAsHistory(memory, [
      botRow("m10", 10, [textBlock("ten")]),
      botRow("m20", 20, [textBlock("twenty")]),
    ]);
    expect(memory.baselined).toBe(true);
    expect(memory.since).toBe(20);

    const hydrated = botRow("m5", 5, [textBlock("five")]);
    expect(takeNewBotReplies([hydrated], memory)).toEqual([]);
    expect(memory.seen.has("m5")).toBe(true);

    const arrival = botRow("m30", 30, [textBlock("thirty")]);
    expect(takeNewBotReplies([hydrated, arrival], memory)).toEqual([
      { messageId: "m30", text: "thirty" },
    ]);
    expect(takeNewBotReplies([hydrated, arrival], memory)).toEqual([]);
  });
});

describe("takeNewBotReplies with a question", () => {
  const question = (settlement: BotQuestionSettlement | null): ReplyRow => ({
    role: "assistant",
    messageId: "q-1",
    timestamp: 20,
    blocks: [textBlock("Ready to release. Ship or hold?")],
    question: {
      requestId: "req-q",
      questions: [
        {
          text: "Ship or hold?",
          options: ["Ship", "Hold"],
          allowFreeText: false,
          settlement,
        },
      ],
    },
  });

  it("gives an open question's choices as an explicit list after its prose", () => {
    const memory = createReplyWatchMemory();
    baselineAsHistory(memory, []);

    expect(takeNewBotReplies([question(null)], memory)).toEqual([
      {
        messageId: "q-1",
        text: "Ready to release. Ship or hold? The choices are: 1. Ship; 2. Hold.",
      },
    ]);
  });

  it("gives a settled question's prose alone", () => {
    const memory = createReplyWatchMemory();
    baselineAsHistory(memory, []);

    expect(
      takeNewBotReplies(
        [
          question({
            answer: "Ship",
            skipped: false,
            by: { kind: "bot" },
            at: 25,
          }),
        ],
        memory,
      ),
    ).toEqual([{ messageId: "q-1", text: "Ready to release. Ship or hold?" }]);
  });
});

describe("baselineReplyWatchExcept", () => {
  it("returns the awaited answer to speak and baselines the rest as history", () => {
    const memory = createReplyWatchMemory();
    const awaited = botRow("a2", 50, [textBlock("Merged.")]);
    const rows: ReadonlyArray<ReplyRow> = [
      botRow("old", 10, [textBlock("history")]),
      userRow("u1", 20),
      awaited,
    ];

    const spoken = baselineReplyWatchExcept(
      memory,
      rows,
      (row) => row.messageId === "a2",
    );

    expect(spoken).toEqual([{ messageId: "a2", text: "Merged." }]);
    expect(memory.baselined).toBe(true);
    expect(memory.since).toBe(20);
    expect([...memory.seen].sort()).toEqual(["a2", "old", "u1"]);
    expect(takeNewBotReplies(rows, memory)).toEqual([]);
  });

  it("speaks nothing of an arrival with no prose, and still marks it seen", () => {
    const memory = createReplyWatchMemory();

    expect(
      baselineReplyWatchExcept(
        memory,
        [botRow("a1", 50, [textBlock("   ")])],
        () => true,
      ),
    ).toEqual([]);
    expect(memory.seen.has("a1")).toBe(true);
  });

  it("leaves an arrival out of the baseline bound, so a row hydrated after it still counts as new", () => {
    const memory = createReplyWatchMemory();
    baselineReplyWatchExcept(
      memory,
      [
        botRow("old", 10, [textBlock("history")]),
        botRow("a2", 50, [textBlock("answer")]),
      ],
      (row) => row.messageId === "a2",
    );

    expect(memory.since).toBe(10);
    expect(
      takeNewBotReplies([botRow("a3", 30, [textBlock("between")])], memory),
    ).toEqual([{ messageId: "a3", text: "between" }]);
  });
});
