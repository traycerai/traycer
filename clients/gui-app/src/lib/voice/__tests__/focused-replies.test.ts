import { describe, expect, it } from "vitest";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  baselineReplyWatch,
  createReplyWatchMemory,
  replySpeechText,
  requestIdAnsweredBy,
  takeNewBotReplies,
  type ReplyRow,
} from "../focused-replies";

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

function userRow(
  messageId: string,
  timestamp: number,
  request: { requestId: string; resolvedByMessageId: string } | null,
): ReplyRow {
  return {
    role: "user",
    messageId,
    timestamp,
    conversationRequest:
      request === null
        ? undefined
        : {
            requestId: request.requestId,
            resolvedAt: timestamp,
            resolvedByMessageId: request.resolvedByMessageId,
          },
  };
}

describe("takeNewBotReplies", () => {
  it("returns only new bot rows with prose, joins their text blocks, and marks every row seen", () => {
    const history = botRow("old", 10, [textBlock("history")]);
    const memory = createReplyWatchMemory();
    baselineReplyWatch(memory, [history]);
    const rows: ReadonlyArray<ReplyRow> = [
      history,
      userRow("u1", 20, null),
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
    baselineReplyWatch(memory, [
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

describe("requestIdAnsweredBy", () => {
  it("reads the request from the user row that resolved to the reply", () => {
    const rows: ReadonlyArray<ReplyRow> = [
      userRow("u1", 1, { requestId: "r-1", resolvedByMessageId: "a1" }),
      userRow("u2", 2, { requestId: "r-2", resolvedByMessageId: "a2" }),
      botRow("a2", 3, [textBlock("Done.")]),
    ];

    expect(requestIdAnsweredBy(rows, "a2")).toBe("r-2");
    expect(requestIdAnsweredBy(rows, "unknown")).toBeNull();
  });
});

describe("replySpeechText", () => {
  it("quotes the bot by name unless the voice speaks as that bot", () => {
    expect(
      replySpeechText({
        botTitle: "Tracy",
        speaksAsThisBot: false,
        content: " Done. ",
      }),
    ).toBe("Tracy answered: Done.");
    expect(
      replySpeechText({
        botTitle: "Tracy",
        speaksAsThisBot: true,
        content: " Done. ",
      }),
    ).toBe("Done.");
  });
});
