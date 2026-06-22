import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
  parseComposerClipboardHtml,
} from "@/lib/composer/composer-clipboard";

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
