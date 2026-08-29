import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import {
  CLASSIFIED_LABELS_FOR_TESTS,
  classifyContentRecovery,
  recoveryTextFromContent,
} from "@/lib/composer/content-recovery";
import { parseLeadingSlashCommand } from "@/lib/composer/tiptap-json-content";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The options this seam mirrors. `bulletMarker` / `listIndent` are left unset
 * so the serializer takes the very defaults `content-recovery` hard-codes -
 * that is the claim under test.
 */
const SERIALIZER_DEFAULTS = {
  mentionFormat: "llm" as const,
  platform: "POSIX" as const,
};

function listDoc(
  type: "bulletList" | "orderedList",
  items: ReadonlyArray<string>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type,
        content: items.map((text) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      },
    ],
  };
}

/** A sub-list indents by DEPTH, never by the parent marker's width. */
const NESTED_ORDERED_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "orderedList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "parent" }] },
            {
              type: "orderedList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "child" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * `-LJlU`: a `hardBreak` in the item's FIRST paragraph. `serializeHardBreak`
 * returns a bare "\n" and `serializeListItem` pushes the first child as one
 * whole string behind the marker, so the second line sits at column zero -
 * the continuation indent belongs to LATER blocks only.
 */
const HARD_BREAK_IN_FIRST_PARAGRAPH_DOC: JsonContent = {
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
              content: [
                { type: "text", text: "foo" },
                { type: "hardBreak" },
                { type: "text", text: "bar" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** ...and the same break in a LATER block, which does take the indent. */
const HARD_BREAK_IN_CONTINUATION_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "orderedList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "step" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "one" },
                { type: "hardBreak" },
                { type: "text", text: "two" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * The corner the mirrored loop settles by construction: the first-child slot
 * is consumed by whatever the first child IS, including a nested list.
 */
const NESTED_LIST_AS_FIRST_CHILD_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "inner" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * `-LV74`: fence blocks carry `listDepth * 2` of their own on EVERY line, and
 * the continuation indent goes on TOP of that - so a top-level bullet's
 * continuation fence goes out at four columns, not two. Paragraphs get no
 * depth indent inside an item, so this is fence-specific.
 */
const FENCE_AS_CONTINUATION_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "run" }] },
            {
              type: "codeBlock",
              attrs: { language: "ts" },
              content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
            },
          ],
        },
      ],
    },
  ],
};

/** Depth compounds: a fence one level in carries four of its own. */
const FENCE_IN_NESTED_ITEM_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "outer" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "inner" }],
                    },
                    {
                      type: "codeBlock",
                      attrs: { language: "" },
                      content: [{ type: "text", text: "deep()" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** ...and as the FIRST child the marker precedes a fence already indented. */
const FENCE_AS_FIRST_CHILD_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "codeBlock",
              attrs: { language: "sh" },
              content: [{ type: "text", text: "echo hi" }],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * `-MlZl`: `serializeTable` escapes `\` then `|` and nothing else, so an
 * embedded hardBreak's newline goes out RAW inside the row. Whether that is
 * well-formed markdown is not the question - it is what the agent received,
 * and the recovery copy has to match it. Plain-text cells only: cell content
 * deliberately routes through this module for mentionFormat consistency, which
 * is documented design rather than drift.
 */
const TABLE_WITH_HARD_BREAK_CELL_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "h1" }] },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "one" },
                    { type: "hardBreak" },
                    { type: "text", text: "two" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** Two block children in one cell - whatever the join is, the byte test says. */
const TABLE_WITH_MULTI_BLOCK_CELL_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "h" }] },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
                { type: "paragraph", content: [{ type: "text", text: "b" }] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * `-MlZs`: `serializeHeading` sends `#`-markers, so a heading recovered as
 * bare text is a different request. Top-level only - the composer schema does
 * not put headings inside list items.
 */
const HEADING_LEVELS_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Title" }],
    },
    { type: "paragraph", content: [{ type: "text", text: "body" }] },
    {
      type: "heading",
      attrs: { level: 4 },
      content: [{ type: "text", text: "Deeper" }],
    },
  ],
};

/** ...while a continuation paragraph indents by exactly that width. */
const NESTED_MIXED_WITH_CONTINUATION_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "orderedList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "step" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "detail" }],
                    },
                  ],
                },
              ],
            },
            { type: "paragraph", content: [{ type: "text", text: "after" }] },
          ],
        },
      ],
    },
  ],
};

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
    // Follows the projection, which now lives in protocol so the host can run
    // the same one. `tiptap-json-content.ts` re-exports it and still names a
    // few node kinds of its own, so reading THAT file would keep passing while
    // silently no longer guarding the enumeration this test is about.
    const source = readFileSync(
      resolve(
        HERE,
        "../../../../../../protocol/src/common/composer-plain-text.ts",
      ),
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

  // `-CbBS`: parity supersedes the round-5 retypeability call. The serializer
  // puts these delimiters on the wire, so they are what the agent receives -
  // and once the optimistic row is gone, nothing else records which span was
  // marked. They stay non-losses, but by seam EMISSION now.
  it("emits inline mark delimiters, matching the serializer", () => {
    const marked: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            { type: "text", text: "not", marks: [{ type: "bold" }] },
            { type: "text", text: " production, " },
            { type: "text", text: "ever", marks: [{ type: "italic" }] },
            { type: "text", text: " run " },
            { type: "text", text: "rm -rf", marks: [{ type: "code" }] },
            { type: "text", text: " or ", marks: [] },
            { type: "text", text: "sudo", marks: [{ type: "strike" }] },
          ],
        },
      ],
    };

    expect(recoveryTextFromContent(marked)).toBe(
      "Use **not** production, *ever* run `rm -rf` or ~~sudo~~",
    );
    // Still non-losses - but now because the seam emits them.
    expect(classifyContentRecovery(marked).size).toBe(0);
  });

  // `-CUdX`: `serializeDocument` joins TOP-LEVEL blocks with `\n\n`, but the
  // shared projection joins every surviving node with a single `\n`. Without
  // this the recovery copy makes a paragraph break look like a hard break, and
  // the optimistic row that could have settled it is already gone.
  it("separates top-level blocks with a blank line, matching the serializer", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    });

    expect(text).toBe("first\n\nsecond");
  });

  // ...but a list is ONE block. Its items are lines within it, so they keep
  // the single newline the serializer gives them - spacing them out would be
  // the same parity error in the other direction.
  it("keeps a list's items on single newlines inside their block", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "steps:" }] },
        {
          type: "orderedList",
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

    expect(text).toBe("steps:\n\n1. one\n2. two");
  });

  // `-HVod`: both editor nodes allow an empty source and both serializers emit
  // the labeled fence anyway. Treating empty as absent dropped the block, so an
  // atom-only draft was reported as having no recoverable content at all.
  it("emits an empty atom block's fence, because its serializer does", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [{ type: "mermaidBlock", attrs: { code: "" } }],
    });

    expect(text).toBe("```mermaid\n\n```");
  });

  // `-H2a9`: convertibility first, then parity - and the composer settles the
  // first outright. `buildComposerExtensions` has no table extension
  // (`@tiptap/extension-table` is in the ARTIFACT bundle only), so the schema
  // cannot hold a table node and no paste rebuilds one. It is a loss.
  //
  // The emission is the worse half: the default container walk joins children
  // with `""`, so this table projected to `envurlproda.test` - the `foobar`
  // list mangling one level up, quoting back something nobody wrote.
  it("emits a table as its markdown grid, and counts the grid as lost", () => {
    const table: JsonContent = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "env" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "url" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "prod" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "a.test" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    // Byte-identical to `jsonContentToMarkdown` on the same input, checked
    // against the serializer rather than reasoned about.
    expect(recoveryTextFromContent(table)).toBe(
      "| env | url |\n| --- | --- |\n| prod | a.test |",
    );
    expect(classifyContentRecovery(table).get("table")).toBe(1);
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

    // Retired category: the target now travels IN the text.
    expect(report.size).toBe(0);
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

    expect(report.size).toBe(0);
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

    expect(report.size).toBe(0);
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

  // R13 `-BZH5`: the leading-only invariant the round-5 note leaned on is
  // EXEMPTED for skills - `isLegalSlashChip` returns true for
  // `kind === "skill"` at any position. A non-leading skill chip's `/name`
  // does not round-trip, because the raw-text converter only rebuilds a
  // LEADING one.
  it("counts a non-leading skill chip as a loss", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first do this then " },
            {
              type: "slashCommand",
              attrs: { kind: "skill", name: "review" },
            },
          ],
        },
      ],
    });

    expect(report.get("command")).toBe(1);
  });

  it("reports nothing for a leading skill chip", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: { kind: "skill", name: "review" },
            },
            { type: "text", text: " the diff" },
          ],
        },
      ],
    });

    // Leading round-trips through `parseLeadingSlashCommand`, so warning here
    // would be noise on the common case.
    expect(report.size).toBe(0);
  });

  // `-CUdW`: "leading" is a claim about the RECOVERY TEXT, not about node
  // position. A skill chip is legal inside a blockquote, and it is genuinely
  // the document's first inline node there - but the seam emits `> /review`,
  // and `LEADING_SLASH_COMMAND_REGEX` accepts only spaces and tabs before the
  // trigger. So it pastes back as prose, silently.
  it("counts a leading skill chip inside a blockquote as a loss", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "slashCommand",
                  attrs: { kind: "skill", name: "review" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.get("command")).toBe(1);
  });

  // Same criterion, the other wrapper that prefixes its first line: an ordered
  // item recovers as `1. /review`.
  it("counts a leading skill chip inside an ordered list as a loss", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "slashCommand",
                      attrs: { kind: "skill", name: "review" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.get("command")).toBe(1);
  });

  // `-Jy8u` flipped this with the marker. The criterion is unchanged -
  // CONVERTIBILITY - but the fact it reads changed: a bullet item now carries
  // `- ` for parity with the serializer, so a chip in the first one recovers
  // as `- /review` and the converter will not rebuild it. Kept as a stated
  // expectation now that the block above holds the marker and the membership
  // together generically: this one says out loud which way a bullet item goes,
  // and a computed check cannot say that.
  it("counts a leading skill chip in a bullet item as a loss", () => {
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
                  content: [
                    {
                      type: "slashCommand",
                      attrs: { kind: "skill", name: "review" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.get("command")).toBe(1);
  });

  // `PKSL`, and the CLASS both drifts on this seam belong to. Whether a chip
  // round-trips is settled by two implementations neither of which lives in
  // `lostSlashChip`: what THIS module emits in front of the chip, and what the
  // converter's parser accepts in front of a trigger. The classifier carried a
  // hand-written mirror of each, and both drifted -
  //
  //  - the emission mirror, twice and QUIETLY: `bulletList` when bullets
  //    started emitting `- `, `heading` when headings started emitting `#`.
  //    Each shipped a chip reported SAFE that no paste path rebuilds.
  //  - the parser mirror, by hard-selecting `children[0]`: an indent-only text
  //    node became the "leading position", so `  /review` - which
  //    `LEADING_SLASH_COMMAND_REGEX` rebuilds, spaces and all - was reported as
  //    a chip to re-pick.
  //
  // So the expectation here is COMPUTED, not listed: project the shape with the
  // real seam, ask the converter's real parser what it would rebuild from that
  // text, and require the report to agree. A shape nobody thought to enumerate
  // still gets the right answer, and a third emission change fails HERE instead
  // of shipping.
  describe("a chip's classification agrees with the seam and the parser", () => {
    const CHIP: JsonContent = {
      type: "slashCommand",
      attrs: { kind: "skill", name: "review" },
    };
    const inParagraph = (
      ...content: ReadonlyArray<JsonContent>
    ): JsonContent => ({ type: "paragraph", content: [...content] });
    const inItem = (type: "bulletList" | "orderedList"): JsonContent => ({
      type,
      content: [{ type: "listItem", content: [inParagraph(CHIP)] }],
    });

    const SHAPES: ReadonlyArray<{
      readonly label: string;
      readonly doc: JsonContent;
    }> = [
      {
        label: "a bare leading chip",
        doc: { type: "doc", content: [inParagraph(CHIP)] },
      },
      {
        label: "a chip behind spaces in their own text node",
        doc: {
          type: "doc",
          content: [inParagraph({ type: "text", text: "  " }, CHIP)],
        },
      },
      {
        label: "a chip behind a tab",
        doc: {
          type: "doc",
          content: [inParagraph({ type: "text", text: "\t" }, CHIP)],
        },
      },
      {
        label: "a chip behind a word",
        doc: {
          type: "doc",
          content: [inParagraph({ type: "text", text: "please " }, CHIP)],
        },
      },
      {
        label: "a chip behind an inline image attachment",
        doc: {
          type: "doc",
          content: [
            inParagraph(
              { type: "imageAttachment", attrs: { src: "blob:x" } },
              CHIP,
            ),
          ],
        },
      },
      {
        label: "a chip after a leading attachment group",
        doc: {
          type: "doc",
          content: [
            {
              type: "attachmentGroup",
              content: [{ type: "imageAttachment", attrs: { src: "blob:x" } }],
            },
            inParagraph(CHIP),
          ],
        },
      },
      {
        label: "a chip in a leading blockquote",
        doc: {
          type: "doc",
          content: [{ type: "blockquote", content: [inParagraph(CHIP)] }],
        },
      },
      {
        label: "a chip in a leading sourced quote",
        doc: {
          type: "doc",
          content: [{ type: "sourcedQuote", content: [inParagraph(CHIP)] }],
        },
      },
      {
        label: "a chip in the first bullet item",
        doc: { type: "doc", content: [inItem("bulletList")] },
      },
      {
        label: "a chip in the first ordered item",
        doc: { type: "doc", content: [inItem("orderedList")] },
      },
      {
        label: "a chip in a leading heading",
        doc: {
          type: "doc",
          content: [{ type: "heading", attrs: { level: 2 }, content: [CHIP] }],
        },
      },
    ];

    it.each(SHAPES)("$label", ({ doc }) => {
      // What the user would actually be handed back, and what the converter
      // would actually do with it. No restatement of either rule.
      const recovered = recoveryTextFromContent(doc);
      const rebuilt = parseLeadingSlashCommand(recovered)?.name === "review";
      expect(classifyContentRecovery(doc).get("command") ?? 0).toBe(
        rebuilt ? 0 : 1,
      );
    });
  });

  // `-G8sl`: a blockquote is not text-complete, because BOTH paste paths
  // deliberately dissolve it - `normalizeComposerMarkdownNode` hoists a parsed
  // blockquote's children into the doc, and `sanitizeMarkdownHtml` unwraps
  // `<blockquote>` via STRIP_TAGS. So a resend never rebuilds the node and
  // never reaches the serializer's `<user_quoted_section>` branch: the agent
  // stops being told which part was quoted.
  it("counts a blockquote as a loss, because pasting it back cannot rebuild it", () => {
    const quoted: JsonContent = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "the part I am asking about" }],
            },
          ],
        },
      ],
    };

    // The CATEGORY, deliberately - not the `> ` prefix. What is lost is the
    // quote-ness, and a test that asserted the prefix would pass just as well
    // if the prefix were the only thing that ever came back.
    expect(classifyContentRecovery(quoted).get("quotedBlock")).toBe(1);
    // The founding invariant still holds: the quoted TEXT is inlined, so the
    // send is stated with its content rather than merely reported lost.
    expect(recoveryTextFromContent(quoted)).toContain(
      "the part I am asking about",
    );
  });

  // `-IfOW`: the native exemption was unconditional because the editor holds a
  // native command at the leading position - but `isLegalSlashChip` asks
  // `leadingTokenBefore`, which is DOCUMENT-WIDE, so a native command as the
  // first token inside a leading blockquote is legal. The editor's "leading"
  // and the raw converter's are different questions, and only the converter's
  // decides whether a copy-back rebuilds the chip.
  it("counts a native command inside a leading blockquote as a loss", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "slashCommand",
                  attrs: { kind: "slash-command", name: "compact" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(report.get("command")).toBe(1);
  });

  it("reports nothing for a native slash-command chip", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: { kind: "slash-command", name: "compact" },
            },
          ],
        },
      ],
    });

    // The leading-only guard still holds for native commands.
    expect(report.size).toBe(0);
  });

  // R13 `-B-Wc`: emission inherits `-4IH`'s adjacency rule. One link across a
  // bold word arrives as three text nodes, so wrapping each independently
  // recovered three separate links where the user wrote one.
  it("emits a link split across text nodes as one link", () => {
    const href = "https://example.test/rb";
    const text = recoveryTextFromContent({
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

    // The inner `**` is `-CbBS`: this expectation used to read
    // `[the bold runbook](...)`, which encoded the very mark-dropping the
    // parity rule now forbids. `jsonContentToMarkdown` on this same input
    // returns exactly the string below - checked against the serializer, not
    // reasoned about.
    expect(text).toBe("[the **bold** runbook](https://example.test/rb)");
  });

  it("emits two separated links to the same target separately", () => {
    const href = "https://example.test/rb";
    const text = recoveryTextFromContent({
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

    // Same rule as counting: not adjacent, so genuinely two links.
    expect(text).toBe(
      "[see here](https://example.test/rb) and also [over here](https://example.test/rb)",
    );
  });

  it("fails closed on an unrecognised slash-chip kind", () => {
    const report = classifyContentRecovery({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "slashCommand", attrs: { name: "mystery" } }],
        },
      ],
    });

    // No kind, no assumption that it round-trips.
    expect(report.get("command")).toBe(1);
  });

  it("emits a link's target into the recovery text", () => {
    const text = recoveryTextFromContent({
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

    // Parity with `serializeLink`, which is also what makes the loss category
    // unnecessary: the target comes back WITH the text.
    expect(text).toBe("[the runbook](https://example.test/rb)");
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

    // Fenced with the serializer's own label, so the reader can tell what the
    // block was and the text round-trips closer to what the agent received.
    expect(text).toBe("```mermaid\ngraph TD;\n  A-->B;\n```");
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

    expect(text).toBe("```wireframe\n<section>hello</section>\n```");
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
    expect(text).toBe("> - foo\n> - bar");
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

  // R12 `-A8bL`: depth and association are structure, not decoration - a
  // nested step read as a sibling of its parent.
  it("indents a nested list under its parent item", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    // Numbering restarts per level, and the child sits under its parent.
    expect(text).toBe("1. parent\n  1. child");
  });

  // R12 `-BQcf`: an item whose nested list is followed by a continuation
  // paragraph used to emit the prose FIRST and the sub-list after, so the
  // trailing note jumped above the steps it was written to follow.
  it("keeps an item's children in document order", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "step" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "detail" }],
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "after" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(text).toBe("1. step\n  - detail\n   after");
  });

  // The parity claim, checked against the REAL serializer rather than against
  // a string someone believed it produced. Every list shape this seam mirrors
  // by hand - bullet marker, ordered marker, nested-list indent (by DEPTH),
  // continuation indent (by marker width) - is one transcription error away
  // from silent divergence, and the four expectations above were written from
  // a reading of `serializeListItem`. This one asks it.
  it("matches jsonContentToMarkdown byte for byte on list shapes", () => {
    const shapes: ReadonlyArray<JsonContent> = [
      listDoc("bulletList", ["one", "two"]),
      listDoc("orderedList", ["one", "two"]),
      NESTED_ORDERED_DOC,
      NESTED_MIXED_WITH_CONTINUATION_DOC,
      HARD_BREAK_IN_FIRST_PARAGRAPH_DOC,
      HARD_BREAK_IN_CONTINUATION_DOC,
      NESTED_LIST_AS_FIRST_CHILD_DOC,
      FENCE_AS_CONTINUATION_DOC,
      FENCE_IN_NESTED_ITEM_DOC,
      FENCE_AS_FIRST_CHILD_DOC,
      TABLE_WITH_HARD_BREAK_CELL_DOC,
      TABLE_WITH_MULTI_BLOCK_CELL_DOC,
      HEADING_LEVELS_DOC,
    ];
    for (const doc of shapes) {
      expect(recoveryTextFromContent(doc)).toBe(
        jsonContentToMarkdown(doc, SERIALIZER_DEFAULTS),
      );
    }
  });

  // `-Jy8u`: the serializer sends `- item`, so a recovery copy without the
  // dash is not the markdown the agent received - and a nested bullet followed
  // by a continuation paragraph came back as two identically-indented lines.
  it("emits bullet markers, matching the serializer", () => {
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
    expect(text).toBe("- one\n- two");
  });

  // R10 `-AdAI`: content ending in a newline plus the join's own newline made
  // a blank code line the user never wrote. The serializer strips exactly one
  // terminal newline; match it byte for byte.
  it("preserves an atom block's terminal newline, matching its serializer", () => {
    const text = recoveryTextFromContent({
      type: "doc",
      content: [{ type: "mermaidBlock", attrs: { code: "graph TD;\n" } }],
    });

    // PARITY: the atom serializers keep a terminal newline, so this does. The
    // source attrs are byte-exact user data the agent received; trimming them
    // for tidiness would be mutating content to improve its looks.
    expect(text).toBe("```mermaid\ngraph TD;\n\n```");
  });

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
