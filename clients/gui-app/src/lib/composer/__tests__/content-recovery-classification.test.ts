import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIED_LABELS_FOR_TESTS,
  classifyContentRecovery,
  recoveryTextFromContent,
} from "@/lib/composer/content-recovery";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `json-content-serializer` is the authoritative enumeration of the node kinds
 * that reach an agent, and `tiptap-json-content`'s projection is what the
 * recovery statement can actually carry. Every kind either enumeration names
 * has to be classified, or the notice can silently present a partial recovery
 * as a whole one - the defect that shipped three times running (attachments,
 * mentions, sourced quotes) before the classification existed.
 */
describe("content recovery classification", () => {
  it("classifies every label the serializer enumerates", () => {
    const source = readFileSync(
      resolve(
        HERE,
        "../../../../../../protocol/src/common/json-content-serializer.ts",
      ),
      "utf8",
    );
    // Extracted from `case "..."` TOKENS, not from a brace-delimited slice.
    // The boundary hunt this replaced keyed on `"\n  }"`, so a reformat could
    // silently shrink the region and let an unclassified kind through - the
    // guard must fail when a kind is ADDED, never when formatting moves.
    // Node kinds and marks both appear as `case` labels here, and both need
    // classifying, so scanning the whole file is the point rather than a
    // limitation.
    const enumerated = [...source.matchAll(/case "([^"]+)":/g)].map(
      (match) => match[1],
    );

    expect(enumerated.length).toBeGreaterThan(15);
    const unclassified = enumerated.filter(
      (label) => !CLASSIFIED_LABELS_FOR_TESTS.has(label),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies every node kind the text projection names", () => {
    const source = readFileSync(
      resolve(HERE, "../tiptap-json-content.ts"),
      "utf8",
    );
    const named = [...source.matchAll(/node\.type === "([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(named.length).toBeGreaterThan(4);
    const unclassified = named.filter(
      (type) => !CLASSIFIED_LABELS_FOR_TESTS.has(type),
    );
    expect(unclassified).toEqual([]);
  });

  it("survives reformatting of the enumeration it reads", () => {
    // The same extraction against a source whose indentation and line breaks
    // have been mangled must still find every label.
    const mangled = `switch(node.type){case "doc":return a(node);\n\ncase "mention":\n      return b(node);}`;
    const enumerated = [...mangled.matchAll(/case "([^"]+)":/g)].map(
      (match) => match[1],
    );

    expect(enumerated).toEqual(["doc", "mention"]);
  });

  it("fails closed on a kind nobody has classified", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [{ type: "someFutureEmbed" }],
    });

    expect(report.get("unknown")).toBe(1);
  });

  it("counts a loss nested inside another lossy node", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "sourcedQuote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mention",
                  attrs: { contextType: "file", path: "a.ts" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.get("quote")).toBe(1);
    expect(report.get("mention")).toBe(1);
  });

  it("counts an attachment group's images once, not once per level", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "attachmentGroup",
          content: [
            { type: "imageAttachment", attrs: { id: "a" } },
            { type: "imageAttachment", attrs: { id: "b" } },
          ],
        },
      ],
    });

    // Two images. The container is scaffolding - counting it as a third
    // attachment tells the user to re-add something that never existed.
    expect(report.get("attachment")).toBe(2);
  });

  it("reports nothing for an empty attachment group", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [{ type: "attachmentGroup", content: [] }],
    });

    expect(report.size).toBe(0);
  });

  it("counts a link whose label hides its target", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "the runbook",
              marks: [
                { type: "link", attrs: { href: "https://example.test/rb" } },
              ],
            },
          ],
        },
      ],
    });

    // "the runbook" pastes back as prose; the URL it pointed at is nowhere.
    expect(report.get("link")).toBe(1);
  });

  it("counts a link split across text nodes once", () => {
    const href = "https://example.test/rb";
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "the ",
              marks: [{ type: "link", attrs: { href } }],
            },
            {
              type: "text",
              text: "bold",
              marks: [{ type: "bold" }, { type: "link", attrs: { href } }],
            },
            {
              type: "text",
              text: " runbook",
              marks: [{ type: "link", attrs: { href } }],
            },
          ],
        },
      ],
    });

    // Tiptap split ONE link into three text nodes; it is still one thing to
    // re-add, and "Its 3 links" would be a lie about the user's message.
    expect(report.get("link")).toBe(1);
  });

  it("counts two separated links to the same target separately", () => {
    const href = "https://example.test/rb";
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "see here",
              marks: [{ type: "link", attrs: { href } }],
            },
            { type: "text", text: " and also " },
            {
              type: "text",
              text: "over here",
              marks: [{ type: "link", attrs: { href } }],
            },
          ],
        },
      ],
    });

    // Not adjacent, so they are two separate things the user has to re-add.
    expect(report.get("link")).toBe(2);
  });

  it("reports nothing for a link whose label IS its target", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "https://example.test/rb",
              marks: [
                { type: "link", attrs: { href: "https://example.test/rb" } },
              ],
            },
          ],
        },
      ],
    });

    // Retypeable: the text and the target are the same string.
    expect(report.size).toBe(0);
  });

  it("reports nothing for visible formatting marks", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "loud", marks: [{ type: "bold" }] },
            { type: "text", text: "quiet", marks: [{ type: "italic" }] },
            { type: "text", text: "x", marks: [{ type: "code" }] },
            { type: "text", text: "y", marks: [{ type: "strike" }] },
          ],
        },
      ],
    });

    expect(report.size).toBe(0);
  });

  it("reports nothing for ordinary prose", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "just words" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.size).toBe(0);
  });

  // `mermaidBlock` and `uiPreviewBlock` are ATOMS (`atom: true`) whose source
  // lives in `attrs.code` / `attrs.htmlContent`. The shared projection walks
  // children, so it emits nothing for them - classifying them text-complete
  // while the projection skips them is the defect: a diagram-only send was
  // told it had "no recoverable content" while its source was deleted.
  it("carries a mermaid block's source into the recovery text", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        { type: "mermaidBlock", attrs: { code: "graph TD;\n  A-->B;" } },
      ],
    });

    expect(text).toBe("graph TD;\n  A-->B;");
  });

  it("carries a UI preview block's source into the recovery text", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "uiPreviewBlock",
          attrs: { htmlContent: "<section>hello</section>" },
        },
      ],
    });

    expect(text).toBe("<section>hello</section>");
  });

  // The recovery text is quoted back verbatim for the user to copy. Trimming
  // it strips meaningful leading indentation - a Python block comes back
  // invalid, and they are told to resend something subtly not theirs.
  // R7 `-oRi`: the round-5 hoist only reached TOP-LEVEL lists. A list nested
  // in a blockquote reached the projection untouched and joined as `foobar`.
  it("keeps list boundaries for a list nested in a blockquote", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "foo" }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "bar" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    // Exact, so a wrong separator or ordering cannot pass: the blockquote
    // prefix is applied per line by `quotePrefixLines`.
    expect(text).toBe("> foo\n> bar");
  });

  it("preserves a code block's leading indentation", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "    if True:\n        pass" }],
        },
      ],
    });

    // Fenced now (`-6Ta`), and the indentation inside is byte-identical.
    expect(text).toBe("```\n    if True:\n        pass\n```");
  });

  // R10 `-AdAM`: a list marker is visible in its absence, but a NUMBER is not.
  // The composer preserves non-default `attrs.start`, so dissolving the list
  // silently renumbered the user's steps from 1.
  it("keeps ordered-list numbering, including a non-default start", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 2 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Second" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(text).toBe("2. First\n3. Second");
  });

  it("leaves bullet markers off, which the criterion allows", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
      ],
    });

    // A `- ` is visible in its absence and retypeable; a number is not.
    expect(text).toBe("one\ntwo");
  });

  // R10 `-AdAI`: content ending in a newline plus the join's own newline made
  // a blank code line the user never wrote. The serializer strips exactly one
  // terminal newline; match it byte for byte.
  it("does not double a code block's terminal newline", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "sh" },
          content: [{ type: "text", text: "echo hi\n" }],
        },
      ],
    });

    expect(text).toBe("```sh\necho hi\n```");
  });

  it("carries a code block's language into the fence", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "python" },
          content: [{ type: "text", text: "print(1)" }],
        },
      ],
    });

    // The language lives in `attrs` and nowhere in the child text, so without
    // the fence a copy-back submitted prose with the language gone.
    expect(text).toBe("```python\nprint(1)\n```");
  });

  it("keeps a blank first line the USER typed", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "sh" },
          content: [{ type: "text", text: "\n#!/bin/sh" }],
        },
      ],
    });

    // Stripping at the LINE level could not tell this newline from an editor
    // wrapper; stripping at the node level never sees it.
    expect(text).toBe("```sh\n\n#!/bin/sh\n```");
  });

  it("still drops editor-generated blank lines at the edges", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "  real" }] },
        { type: "paragraph" },
      ],
    });

    // The empty wrapper PARAGRAPHS go; the content line keeps its own spaces.
    expect(text).toBe("  real");
  });
});
