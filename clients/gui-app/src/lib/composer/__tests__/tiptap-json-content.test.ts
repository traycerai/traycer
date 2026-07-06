import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

describe("extractPlainTextFromComposerJSONContent blockquote handling", () => {
  it("emits '> '-prefixed lines for a multi-paragraph quote", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "first line" }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "second line" }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "reply" }],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      ["> first line", "> second line", "reply"].join("\n"),
    );
  });

  it("emits a bare '>' for an empty line inside the quote", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
            { type: "paragraph" },
          ],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      ["> quoted", ">"].join("\n"),
    );
  });
});
