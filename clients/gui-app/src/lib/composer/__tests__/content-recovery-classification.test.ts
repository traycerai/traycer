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

    expect(text).toContain("graph TD;");
    expect(text).toContain("A-->B;");
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

    expect(text).toContain("<section>hello</section>");
  });

  // The recovery text is quoted back verbatim for the user to copy. Trimming
  // it strips meaningful leading indentation - a Python block comes back
  // invalid, and they are told to resend something subtly not theirs.
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

    expect(text).toBe("    if True:\n        pass");
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

    // The empty wrapper paragraphs go; the content line keeps its own spaces.
    expect(text).toBe("  real");
  });
});
