import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  sideChatCommandName,
  sideChatSlashCommands,
  sideChatTitle,
  splitLeadingSideChatCommand,
} from "../side-chat-command";

describe("sideChatCommandName", () => {
  it("recognizes btw and side, case-insensitively", () => {
    expect(sideChatCommandName("btw")).toBe("btw");
    expect(sideChatCommandName("BTW")).toBe("btw");
    expect(sideChatCommandName("side")).toBe("side");
    expect(sideChatCommandName("SIDE")).toBe("side");
  });

  it("refuses an unrelated name", () => {
    expect(sideChatCommandName("btwx")).toBeNull();
    expect(sideChatCommandName("review")).toBeNull();
  });
});

describe("splitLeadingSideChatCommand", () => {
  it("recognizes a leading slashCommand chip, case-insensitively, and strips the following space", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "BTW" } },
            { type: "text", text: " why is it slow?" },
          ],
        },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result).toEqual({
      command: "btw",
      rest: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "why is it slow?" }],
          },
        ],
      },
    });
  });

  it("recognizes a raw text /btw and strips it", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "/btw why?" }] },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result?.command).toBe("btw");
    expect(result?.rest).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "why?" }] },
      ],
    });
  });

  it("keeps a preceding indent node and strips exactly one space", () => {
    // Mirrors what chip-conversion of "  /side  question" produces: the
    // indent lives in its own text node ahead of the chip, and the trailing
    // text node keeps both spaces of the typed separator. The indent is
    // untouched; only ONE separator space goes (the one the chip stands in
    // for), the rest of the user's spacing is theirs.
    const doc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "  " },
            { type: "slashCommand", attrs: { commandName: "side" } },
            { type: "text", text: "  question" },
          ],
        },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result).toEqual({
      command: "side",
      rest: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "  " },
              { type: "text", text: " question" },
            ],
          },
        ],
      },
    });
  });

  it("a bare /btw leaves an empty paragraph with no content", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "/btw" }] },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result).toEqual({
      command: "btw",
      rest: { type: "doc", content: [{ type: "paragraph" }] },
    });
  });

  it("drops a hard break used only to end the command token", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "/btw" },
            { type: "hardBreak" },
            { type: "text", text: "question" },
          ],
        },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result?.command).toBe("btw");
    expect(result?.rest).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "question" }],
        },
      ],
    });
  });

  it("refuses a near-miss name, an unrelated provider command, and plain prose", () => {
    const btwx: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "/btwx hello" }] },
      ],
    };
    const review: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "/review hello" }],
        },
      ],
    };
    const prose: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello there" }] },
      ],
    };
    expect(splitLeadingSideChatCommand(btwx)).toBeNull();
    expect(splitLeadingSideChatCommand(review)).toBeNull();
    expect(splitLeadingSideChatCommand(prose)).toBeNull();
  });

  it("refuses a /btw that opens a leading code block (not a command context)", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: "/btw hi" }] },
        { type: "paragraph", content: [{ type: "text", text: "trailer" }] },
      ],
    };
    expect(splitLeadingSideChatCommand(doc)).toBeNull();
  });

  it("reads through a leading imageAttachment and preserves it in rest", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "imageAttachment", attrs: { hash: "abc" } },
        {
          type: "paragraph",
          content: [{ type: "text", text: "/btw hi there" }],
        },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result).toEqual({
      command: "btw",
      rest: {
        type: "doc",
        content: [
          { type: "imageAttachment", attrs: { hash: "abc" } },
          {
            type: "paragraph",
            content: [{ type: "text", text: "hi there" }],
          },
        ],
      },
    });
  });

  it("preserves trailing paragraphs untouched", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "/btw hi" }] },
        { type: "paragraph", content: [{ type: "text", text: "second para" }] },
      ],
    };
    const result = splitLeadingSideChatCommand(doc);
    expect(result).toEqual({
      command: "btw",
      rest: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
          {
            type: "paragraph",
            content: [{ type: "text", text: "second para" }],
          },
        ],
      },
    });
  });
});

describe("sideChatSlashCommands", () => {
  it("returns the btw and side rows stamped with the composer's harness", () => {
    const rows = sideChatSlashCommands("claude");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.name)).toEqual(["btw", "side"]);
    for (const row of rows) {
      expect(row.source).toBe("local");
      expect(row.kind).toBe("slash-command");
      expect(row.harnessId).toBe("claude");
    }
  });
});

describe("sideChatTitle", () => {
  it("prefixes the first line of the question, truncated to 60 chars", () => {
    expect(sideChatTitle("why is it slow?\nmore", "Source")).toBe(
      "Side - why is it slow?",
    );
    const long = "x".repeat(70);
    expect(sideChatTitle(long, "Source")).toBe(`Side - ${"x".repeat(59)}…`);
  });

  it("falls back to the source title when the question is empty", () => {
    expect(sideChatTitle("", "Source Title")).toBe("Side - Source Title");
  });

  it("returns an empty title when both the question and the source are empty", () => {
    expect(sideChatTitle("", "")).toBe("");
    expect(sideChatTitle("   ", "   ")).toBe("");
  });

  it("truncates by code point so an emoji at the boundary is never split", () => {
    // 58 plain chars puts a 2-unit emoji astride the 59-code-unit cut, which
    // `String.slice` would halve into an unpaired surrogate (renders as `�`).
    const title = sideChatTitle(`${"x".repeat(58)}🙂 tail`, "Source");
    expect(title).toBe(`Side - ${"x".repeat(58)}🙂…`);
    for (const char of title) {
      const code = char.codePointAt(0) ?? 0;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });
});
