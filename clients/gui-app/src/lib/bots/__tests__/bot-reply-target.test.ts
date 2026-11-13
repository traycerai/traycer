import { describe, expect, it } from "vitest";
import {
  BOT_REPLY_LINE_MAX,
  botReplyTargetOf,
  storedBotReplyTargetOf,
} from "@/lib/bots/bot-reply-target";

describe("botReplyTargetOf", () => {
  it("keeps the message, its writer and the first line of its text", () => {
    expect(
      botReplyTargetOf("message-1", "Sam", "Ship it on Friday\nthen announce"),
    ).toEqual({
      messageId: "message-1",
      author: "Sam",
      line: "Ship it on Friday",
    });
  });

  it.each([
    ["no text", null],
    ["only blank lines", " \n  "],
  ])("has no line for a message with %s", (_name, text) => {
    expect(botReplyTargetOf("message-1", "Sam", text).line).toBeNull();
  });

  it("keeps a line of exactly the most it stores whole", () => {
    const line = "a".repeat(BOT_REPLY_LINE_MAX);
    expect(botReplyTargetOf("message-1", "Sam", line).line).toBe(line);
  });

  it("cuts a longer line to the most it stores, an ellipsis marking the cut", () => {
    const { line } = botReplyTargetOf(
      "message-1",
      "Sam",
      "a".repeat(BOT_REPLY_LINE_MAX + 50),
    );
    expect(line).toBe(`${"a".repeat(BOT_REPLY_LINE_MAX - 1)}…`);
  });

  it("cuts between characters as a reader counts them, never inside a joined emoji", () => {
    const family = "👩‍👩‍👧";
    const { line } = botReplyTargetOf(
      "message-1",
      "Sam",
      `${"a".repeat(BOT_REPLY_LINE_MAX - 2)}${family}${"b".repeat(50)}`,
    );
    expect(line).toBe(`${"a".repeat(BOT_REPLY_LINE_MAX - 2)}${family}…`);
  });
});

describe("storedBotReplyTargetOf", () => {
  const STORED = { messageId: "message-1", author: "Sam", line: "Ship it" };

  it("reads back a target as it was stored, with and without a line", () => {
    expect(storedBotReplyTargetOf(STORED)).toEqual(STORED);
    expect(storedBotReplyTargetOf({ ...STORED, line: null })).toEqual({
      ...STORED,
      line: null,
    });
  });

  it.each([
    ["is not a record", "message-1"],
    ["has an empty message id", { ...STORED, messageId: "" }],
    ["has a writer that is not a string", { ...STORED, author: 7 }],
    ["has a line that is neither a string nor null", { ...STORED, line: 7 }],
  ])("reads nothing from a value that %s", (_name, value) => {
    expect(storedBotReplyTargetOf(value)).toBeNull();
  });

  it("cuts a line stored longer than the most it keeps", () => {
    expect(
      storedBotReplyTargetOf({
        ...STORED,
        line: "a".repeat(BOT_REPLY_LINE_MAX + 50),
      })?.line,
    ).toBe(`${"a".repeat(BOT_REPLY_LINE_MAX - 1)}…`);
  });
});
