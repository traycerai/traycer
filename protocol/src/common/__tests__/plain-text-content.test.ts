import { describe, expect, it } from "vitest";
import {
  plainTextJsonContent,
  withImageParagraph,
} from "@traycer/protocol/common/plain-text-content";
import type { JsonContent } from "@traycer/protocol/common/registry";

const text = (value: string): JsonContent => ({ type: "text", text: value });
const hardBreak: JsonContent = { type: "hardBreak" };

describe("plainTextJsonContent", () => {
  it("makes an empty string an empty document", () => {
    expect(plainTextJsonContent("")).toEqual({ type: "doc", content: [] });
  });

  it("splits paragraphs at two or more newlines", () => {
    expect(plainTextJsonContent("First\n\nSecond\n\n\n\nThird")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [text("First")] },
        { type: "paragraph", content: [text("Second")] },
        { type: "paragraph", content: [text("Third")] },
      ],
    });
  });

  it("makes a single newline a hard break inside its paragraph", () => {
    expect(plainTextJsonContent("First\nSecond")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [text("First"), hardBreak, text("Second")],
        },
      ],
    });
  });

  it("gives a line with nothing on it a hard break and no empty text node", () => {
    expect(plainTextJsonContent("\nSecond")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [hardBreak, text("Second")] }],
    });
  });
});

describe("withImageParagraph", () => {
  const image = (id: string): JsonContent => ({
    type: "imageAttachment",
    attrs: { id },
  });
  const document = plainTextJsonContent("Release notes");

  it("appends the images, in order, in one paragraph of their own", () => {
    expect(withImageParagraph(document, [image("a"), image("b")])).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [text("Release notes")] },
        { type: "paragraph", content: [image("a"), image("b")] },
      ],
    });
  });

  it("returns the document as it is when there are no images", () => {
    expect(withImageParagraph(document, [])).toBe(document);
  });
});
