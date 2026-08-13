/**
 * Protocol GUI converter authority: image nodes serialize to portable
 * markdown only (src + alt). attachmentHash is collaboration-only.
 */
import { describe, expect, it } from "vitest";
import type { JsonContent } from "../registry";
import { jsonContentToMarkdown } from "../json-content-serializer";

function toMarkdown(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
}

describe("jsonContentToMarkdown image nodes", () => {
  it("serializes src and alt as ![alt](src)", () => {
    expect(
      toMarkdown({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              src: "images/abc.png",
              alt: "shot",
              attachmentHash: "abc",
            },
          },
        ],
      }),
    ).toBe("![shot](images/abc.png)");
  });

  it("never serializes attachmentHash into portable markdown", () => {
    const hash = "feedface0123456789";
    const markdown = toMarkdown({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: `images/${hash}.png`,
            alt: "diagram",
            attachmentHash: hash,
          },
        },
      ],
    });
    expect(markdown).toBe(`![diagram](images/${hash}.png)`);
    // Hash may appear in the relative src path, but never as a separate attr.
    expect(markdown).not.toMatch(/attachmentHash/i);
    expect(markdown).not.toContain(`(${hash})`);
    expect(markdown).not.toContain(`"${hash}"`);
  });

  it("omits empty-src image nodes rather than emitting broken markup", () => {
    expect(
      toMarkdown({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: "", alt: "missing", attachmentHash: "x" },
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "after" }],
          },
        ],
      }),
    ).toBe("after");
  });

  it("escapes brackets and backslashes in filename-derived alt text", () => {
    const hash = "feedface0123456789";
    const markdown = toMarkdown({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: `images/${hash}.png`,
            alt: String.raw`a]b\c.png`,
            attachmentHash: hash,
          },
        },
      ],
    });
    expect(markdown).toBe(String.raw`![a\]b\\c.png](images/${hash}.png)`);
    expect(markdown).not.toMatch(/attachmentHash/i);
    // Hash may appear in the relative src path, never as a free-standing token.
    expect(markdown).not.toContain(`(${hash})`);
  });

  it("wraps destinations containing spaces or parentheses", () => {
    expect(
      toMarkdown({
        type: "image",
        attrs: { src: "images/my file.png", alt: "shot" },
      }),
    ).toBe("![shot](<images/my file.png>)");
    expect(
      toMarkdown({
        type: "image",
        attrs: { src: "images/f(1).png", alt: "shot" },
      }),
    ).toBe("![shot](<images/f(1).png>)");
  });
});
