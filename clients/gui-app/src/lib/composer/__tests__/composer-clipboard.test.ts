import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
  composerClipboardTextSerializer,
  parseComposerClipboardHtml,
} from "@/lib/composer/composer-clipboard";

function docNode(doc: JsonContent) {
  return getSchema([StarterKit]).nodeFromJSON(doc);
}

const STRUCTURED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "slashCommand", attrs: { commandName: "implement" } },
        { type: "text", text: " preserve " },
        {
          type: "mention",
          attrs: {
            contextType: "file",
            path: "src/app.tsx",
            relPath: "src/app.tsx",
            pathKind: "file",
          },
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bullet one" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bullet two" }],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "step one" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "step two" }],
            },
          ],
        },
      ],
    },
  ],
};

describe("composer clipboard helpers", () => {
  it("keeps readable bullets, numbering, mentions, and skills in plain text", () => {
    expect(composerClipboardPlainText(STRUCTURED_CONTENT)).toBe(
      [
        "/implement preserve @src/app.tsx",
        "",
        "- bullet one",
        "- bullet two",
        "",
        "1. step one",
        "2. step two",
      ].join("\n"),
    );
  });

  it("round-trips structured composer content through clipboard HTML", () => {
    const plainText = composerClipboardPlainText(STRUCTURED_CONTENT);
    const html = buildComposerClipboardHtml(STRUCTURED_CONTENT, plainText);

    expect(parseComposerClipboardHtml(html)).toEqual(STRUCTURED_CONTENT);
    expect(html).toContain("- bullet one<br>- bullet two");
  });
});

describe("composerClipboardTextSerializer", () => {
  it("keeps bullet and ordered markers when serializing a copied slice", () => {
    // A select-all copy: the whole document.
    const node = docNode({
      type: "doc",
      content: [
        { type: "bulletList", content: [listItem("alpha"), listItem("beta")] },
        {
          type: "orderedList",
          content: [listItem("first"), listItem("second")],
        },
      ],
    });
    const slice = node.slice(0, node.content.size);

    // Default ProseMirror serialization would yield "alpha\n\nbeta\n\nfirst…"
    // with the markers stripped; the structured serializer keeps them.
    expect(composerClipboardTextSerializer(slice)).toBe(
      ["- alpha", "- beta", "", "1. first", "2. second"].join("\n"),
    );
  });

  it("does not inject blank lines into an inline (within-paragraph) selection", () => {
    const node = docNode({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
      ],
    });
    // Positions 2..11 land inside the single text node -> "ello worl".
    const slice = node.slice(2, 11);
    expect(composerClipboardTextSerializer(slice)).toBe("ello worl");
  });

  it("returns an empty string for an empty slice", () => {
    const node = docNode({ type: "doc", content: [{ type: "paragraph" }] });
    expect(composerClipboardTextSerializer(node.slice(0, 0))).toBe("");
  });
});

function listItem(text: string): JsonContent {
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
