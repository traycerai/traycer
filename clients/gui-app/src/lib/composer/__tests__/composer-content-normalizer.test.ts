import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  normalizeComposerContent,
  normalizeComposerContentWithSelection,
} from "@/lib/composer/composer-content-normalizer";
import {
  buildAttachmentsFromJSONContent,
  buildSubmittedChatJSONContent,
} from "@/lib/composer/tiptap-json-content";

describe("normalizeComposerContent", () => {
  it("rewrites legacy leading attachmentGroup content into inline image atoms", () => {
    expect(
      normalizeComposerContent({
        type: "doc",
        content: [
          {
            type: "attachmentGroup",
            content: [imageNode("img-1"), imageNode("img-2")],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "describe these" }],
          },
        ],
      }),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            imageNode("img-1"),
            imageNode("img-2"),
            { type: "text", text: "describe these" },
          ],
        },
      ],
    });
  });

  it("preserves inline image atoms for positional awareness", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "use " },
            imageNode("img-1"),
            { type: "text", text: " here" },
          ],
        },
      ],
    };

    expect(normalizeComposerContent(content)).toBe(content);
  });

  it("maps a mid-text legacy selection to the same text offset", () => {
    const normalized = normalizeComposerContentWithSelection(
      {
        type: "doc",
        content: [
          {
            type: "attachmentGroup",
            content: [imageNode("img-1")],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "abcdef" }],
          },
        ],
      },
      { from: 7, to: 7 },
    );

    expect(normalized.selection).toEqual({ from: 5, to: 5 });
  });

  it("does not remap a selection when image atoms are already inline", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "abc" },
            imageNode("img-1"),
            { type: "text", text: "def" },
          ],
        },
      ],
    };
    const normalized = normalizeComposerContentWithSelection(content, {
      from: 6,
      to: 6,
    });

    expect(normalized.changed).toBe(false);
    expect(normalized.selection).toEqual({ from: 6, to: 6 });
  });

  it("maps a legacy selection after synthesized image paragraph without shifting into a code block", () => {
    const normalized = normalizeComposerContentWithSelection(
      {
        type: "doc",
        content: [
          {
            type: "attachmentGroup",
            content: [imageNode("img-1")],
          },
          {
            type: "codeBlock",
            content: [{ type: "text", text: "const x=1" }],
          },
        ],
      },
      { from: 13, to: 13 },
    );

    expect(normalized.content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [imageNode("img-1")],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x=1" }],
        },
      ],
    });
    expect(normalized.selection).toEqual({ from: 13, to: 13 });
  });

  it("normalizes slash commands with images before the command text", () => {
    expect(
      buildSubmittedChatJSONContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              imageNode("img-1"),
              { type: "text", text: "/plan review this" },
            ],
          },
        ],
      }),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            imageNode("img-1"),
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: " review this" },
          ],
        },
      ],
    });
  });

  it("does not normalize slash command text from a later block after an image-only block", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [imageNode("img-1")],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "/plan review this" }],
        },
      ],
    };

    expect(buildSubmittedChatJSONContent(content)).toBe(content);
  });

  it("does not convert a leading slash command inside a non-paragraph block", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "/plan review this" }],
        },
      ],
    };

    expect(buildSubmittedChatJSONContent(content)).toBe(content);
  });

  it("extracts image attachments in document traversal order", () => {
    const submitted = buildSubmittedChatJSONContent({
      type: "doc",
      content: [
        {
          type: "attachmentGroup",
          content: [imageNode("legacy-1"), imageNode("legacy-2")],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "/plan " },
            imageNode("inline-1"),
            { type: "text", text: "then " },
            imageNode("inline-2"),
          ],
        },
      ],
    });

    expect(
      buildAttachmentsFromJSONContent(submitted).map((attachment) =>
        attachment.kind === "image" ? attachment.name : null,
      ),
    ).toEqual(["legacy-1.png", "legacy-2.png", "inline-1.png", "inline-2.png"]);
  });
});

function imageNode(id: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName: `${id}.png`,
      b64content: id,
      mimeType: "image/png",
      size: id.length,
    },
  };
}
