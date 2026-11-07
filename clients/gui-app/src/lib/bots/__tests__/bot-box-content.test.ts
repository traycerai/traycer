import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  botBoxAttachments,
  botBoxContentOf,
  botBoxText,
  botBoxWire,
} from "@/lib/bots/bot-box-content";
import type { BotMentionKind } from "@/lib/bots/bot-mentions";
import { BOT_TOKEN_CONTEXT_TYPE } from "@/lib/composer/tiptap-json-content";

const BOT_ID = "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1";
const TASK_ID = "3f2c1d7a-8b4e-4c6f-9a10-2d3e4f5a6b7c";

function chip(token: string, label: string): JsonContent {
  return {
    type: "mention",
    attrs: { contextType: BOT_TOKEN_CONTEXT_TYPE, id: token, label },
  };
}

function doc(...paragraphs: JsonContent[][]): JsonContent {
  return {
    type: "doc",
    content: paragraphs.map((content) => ({ type: "paragraph", content })),
  };
}

const NAMES: Readonly<Record<BotMentionKind, string>> = {
  person: "Ada",
  bot: "Scout",
  task: "Redesign",
};

function nameOf(kind: BotMentionKind): string | null {
  return NAMES[kind];
}

describe("the box's text", () => {
  it("writes each kind of chip as its token, and reads it as its name", () => {
    const content = doc([
      { type: "text", text: "Ask " },
      chip("<@user-1>", "Ada"),
      { type: "text", text: " and " },
      chip(`<#${BOT_ID}>`, "Scout"),
      { type: "text", text: " about " },
      chip(`<~${TASK_ID}>`, "Redesign"),
    ]);
    expect(botBoxWire(content)).toBe(
      `Ask <@user-1> and <#${BOT_ID}> about <~${TASK_ID}>`,
    );
    expect(botBoxText(content)).toBe("Ask @Ada and @Scout about @Redesign");
  });

  it("keeps a host mention's canonical id in the sent text", () => {
    const content = doc([
      {
        type: "mention",
        attrs: { contextType: "host", id: "host-42", label: "Laptop" },
      },
    ]);
    expect(botBoxWire(content)).toBe("@host:Laptop [hostId=host-42]");
    expect(botBoxText(content)).toBe("@host:Laptop [hostId=host-42]");
  });

  it("falls back to the host id and marks a missing id", () => {
    const host = (attrs: Record<string, unknown>): JsonContent => ({
      type: "mention",
      attrs: { contextType: "host", ...attrs },
    });
    const noLabel = doc([host({ id: "host-42" })]);
    expect(botBoxWire(noLabel)).toBe("@host:host-42 [hostId=host-42]");
    expect(botBoxText(noLabel)).toBe("@host:host-42 [hostId=host-42]");
    const noId = doc([host({ label: "Laptop" })]);
    expect(botBoxWire(noId)).toBe("@host:Laptop [hostId is unavailable]");
    expect(botBoxText(noId)).toBe("@host:Laptop [hostId is unavailable]");
  });

  it("keeps formatting on a mention when replacing its chip with a token", () => {
    const formatted: JsonContent = {
      ...chip("<@user-1>", "Ada"),
      marks: [{ type: "code" }],
    };
    expect(botBoxWire(doc([formatted]))).toBe("`<@user-1>`");
  });

  it("leaves typed Markdown and tokens as they were typed", () => {
    const typed = [
      "**bold** _italic_ `code` [a](https://b.c)",
      "1 < 2 && 3 > 2, <#include>, <@user-1>",
      "- not a list here",
      "> not a quote here",
    ];
    for (const line of typed) {
      expect(botBoxWire(doc([{ type: "text", text: line }]))).toBe(line);
    }
  });

  it("writes what the editor formatted back as Markdown", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " then " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "quoted" }] },
          ],
        },
      ],
    };
    expect(botBoxWire(content)).toBe(
      "**bold** then `code`\n\n- one\n\n> quoted",
    );
  });

  it("writes a quote as Markdown, a code selection in its fence", () => {
    const quoted = (node: JsonContent): JsonContent => ({
      type: "doc",
      content: [
        { type: "blockquote", content: [node] },
        { type: "paragraph", content: [{ type: "text", text: "my reply" }] },
      ],
    });
    expect(
      botBoxWire(
        quoted({
          type: "paragraph",
          content: [{ type: "text", text: "a <@user-1> line" }],
        }),
      ),
    ).toBe("> a <@user-1> line\n\nmy reply");
    expect(
      botBoxWire(
        quoted({
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1;\n\nconst b = 2;" }],
        }),
      ),
    ).toBe("> ```ts\n> const a = 1;\n>\n> const b = 2;\n> ```\n\nmy reply");
  });

  it("breaks a line where the person did", () => {
    expect(
      botBoxWire(
        doc([
          { type: "text", text: "one" },
          { type: "hardBreak" },
          { type: "text", text: "two" },
        ]),
      ),
    ).toBe("one\ntwo");
  });

  it("leaves images out of the text, and is empty with nothing else", () => {
    const image: JsonContent = {
      type: "imageAttachment",
      attrs: {
        id: "1",
        fileName: "a.png",
        mimeType: "image/png",
        b64content: "AAAA",
        size: 3,
      },
    };
    expect(botBoxWire(doc([image]))).toBe("");
    expect(botBoxWire(doc([{ type: "text", text: "hi " }, image]))).toBe("hi");
  });
});

describe("text back into the box", () => {
  it("round-trips a message's text and its tokens", () => {
    const wire = `Hi <@user-1>,\nsee <#${BOT_ID}>\n\nand <~${TASK_ID}> **now**`;
    const content = botBoxContentOf(wire, nameOf);
    expect(botBoxWire(content)).toBe(wire);
    expect(botBoxText(content)).toBe(
      "Hi @Ada,\nsee @Scout\n\nand @Redesign **now**",
    );
  });

  it("keeps a token the box cannot name as written", () => {
    const wire = "<@gone> and <@user-1>";
    const content = botBoxContentOf(wire, (kind, id) =>
      id === "gone" ? null : nameOf(kind),
    );
    expect(content).toEqual(
      doc([{ type: "text", text: "<@gone> and " }, chip("<@user-1>", "Ada")]),
    );
    expect(botBoxWire(content)).toBe(wire);
  });
});

describe("the box's images", () => {
  it("carries only what a message can: inline bytes of an accepted type", () => {
    const image = (attrs: Record<string, unknown>): JsonContent => ({
      type: "imageAttachment",
      attrs: { id: "1", fileName: "a.png", size: null, ...attrs },
    });
    expect(
      botBoxAttachments(
        doc([
          image({ mimeType: "image/png", b64content: "AAECAw==" }),
          image({ mimeType: "image/svg+xml", b64content: "AAAA" }),
          image({ mimeType: "image/png", hash: "abc" }),
        ]),
      ),
    ).toEqual([
      {
        b64content: "AAECAw==",
        mediaType: "image/png",
        fileName: "a.png",
        size: 4,
      },
    ]);
  });
});
