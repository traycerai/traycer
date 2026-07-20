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

// The slash picker classifies a command as "leading" by asking what the
// provider's parser will see, not by where the chip sits in the document. That
// only holds while an attachment-only block contributes nothing to the prompt -
// if it ever serialized to a blank line instead of being dropped, a native
// command below it would stop being leading and the picker would silently
// offer commands the provider then refuses.
describe("extractPlainTextFromComposerJSONContent attachment blocks", () => {
  it("drops an attachment-only block so a following command stays leading", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "imageAttachment", attrs: { imageId: "img-1" } }],
        },
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: " ship it" },
          ],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      "/plan ship it",
    );
  });

  // The mirror of the case above, and the reason a blockquote can never be
  // skipped the way an attachment block is: `quotePrefixLines` emits a bare `>`
  // for a blank line, so even a visually empty quote puts a character in front
  // of the command and the provider stops seeing a leading slash.
  it("keeps a '>' for a blank quote so a following command is not leading", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "hardBreak" }] }],
        },
        {
          type: "paragraph",
          content: [{ type: "slashCommand", attrs: { commandName: "plan" } }],
        },
      ],
    };

    expect(extractPlainTextFromComposerJSONContent(content)).toBe(
      ">\n>\n/plan",
    );
  });
});
