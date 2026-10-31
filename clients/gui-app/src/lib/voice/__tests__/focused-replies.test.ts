import { describe, expect, it } from "vitest";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  replySpeechText,
  seenMessageIds,
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

function botRow(messageId: string, blocks: OpenTextBlock[]): ReplyRow {
  return { role: "assistant", messageId, blocks };
}

describe("takeNewBotReplies", () => {
  it("returns only unseen bot rows with prose, joins their text blocks, and marks every row seen", () => {
    const rows: ReadonlyArray<ReplyRow> = [
      botRow("old", [textBlock("history")]),
      { role: "user", messageId: "u1" },
      botRow("a1", [textBlock("Yes."), textBlock("Merged.")]),
      botRow("a2", [textBlock("   ")]),
    ];
    const seen = seenMessageIds([rows[0]]);

    expect(takeNewBotReplies(rows, seen)).toEqual([
      { messageId: "a1", text: "Yes.\n\nMerged." },
    ]);
    expect([...seen].sort()).toEqual(["a1", "a2", "old", "u1"]);
    expect(takeNewBotReplies(rows, seen)).toEqual([]);
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
