import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { jsonContentToArtifactMarkdown } from "@traycer/protocol/common/json-content-serializer";
import { artifactDocumentBundle } from "../artifact-document-bundle";

/**
 * The artifact serializer's markdown must be a fixed point of
 * md -> doc -> md, and re-ingesting it must produce the identical Yjs
 * document. The disk mirror writes serializer output and the ingest path
 * parses it back, so any markup the serializer leaves unescaped changes the
 * document on the next pass and shows up as sync churn (traycer#1563).
 */

const { markdownManager, schema } = artifactDocumentBundle;

const OPTIONS = { mentionFormat: "llm", platform: "POSIX" } as const;

const CORPUS: ReadonlyArray<{
  readonly name: string;
  readonly md: string;
  readonly hasHardBreak: boolean;
}> = [
  {
    name: "identifier with underscores",
    md: "foo_bar_baz and snake_case_name",
    hasHardBreak: false,
  },
  {
    name: "bare URL with underscores",
    md: "see https://example.com/a_b_c",
    hasHardBreak: false,
  },
  {
    name: "autolink with underscores",
    md: "<https://example.com/a_b>",
    hasHardBreak: false,
  },
  { name: "inline code holding markup", md: "`a*b_c[d]`", hasHardBreak: false },
  { name: "escaped asterisk", md: "2 \\* 3", hasHardBreak: false },
  { name: "escaped backtick", md: "a \\` b", hasHardBreak: false },
  { name: "escaped open bracket", md: "\\[x\\]", hasHardBreak: false },
  { name: "escaped close bracket", md: "a \\] b", hasHardBreak: false },
  { name: "escaped angle brackets", md: "\\<b\\>", hasHardBreak: false },
  { name: "escaped leading underscore", md: "\\_leading", hasHardBreak: false },
  { name: "escaped tildes", md: "\\~tilde\\~", hasHardBreak: false },
  { name: "escaped entity", md: "\\&amp;", hasHardBreak: false },
  {
    name: "backslash before punctuation",
    md: "a \\\\* b",
    hasHardBreak: false,
  },
  {
    name: "escaped heading marker",
    md: "\\# not a heading",
    hasHardBreak: false,
  },
  { name: "escaped bullet marker", md: "\\- not a list", hasHardBreak: false },
  {
    name: "escaped ordered marker",
    md: "1\\. not ordered",
    hasHardBreak: false,
  },
  { name: "escaped quote marker", md: "\\> not a quote", hasHardBreak: false },
  { name: "escaped thematic break", md: "\\---", hasHardBreak: false },
  {
    name: "link with underscores",
    md: "[text_with_underscore](https://example.com/x_y)",
    hasHardBreak: false,
  },
  {
    name: "table with asterisk and underscore in a cell",
    md: "| h | i |\n| --- | --- |\n| a\\*b | c\\_d |",
    hasHardBreak: false,
  },
  {
    name: "blockquote with bold",
    md: "> quoted **bold**",
    hasHardBreak: false,
  },
  {
    name: "bullet list in a quote in a third-level list item",
    md: "- a\n  - b\n    - c\n      > - x",
    hasHardBreak: false,
  },
  {
    name: "escaped marker behind leading spaces on a later line",
    md: "a\n  \\# h",
    hasHardBreak: false,
  },
  {
    name: "escaped marker behind leading spaces on a later paragraph's first line",
    md: "first\n\n  \\# h",
    hasHardBreak: false,
  },
  {
    name: "escaped text that looks like an image followed by a link",
    md: "!\\[x](a) \\[y](b)",
    hasHardBreak: false,
  },
  // A list item's later paragraph is traycerai/traycer#2574's fixed point.
  { name: "backslash hard break", md: "First\\\nSecond", hasHardBreak: true },
  {
    name: "backslash hard break in a bullet item",
    md: "- First\\\n  Second",
    hasHardBreak: true,
  },
  {
    name: "heading with asterisk",
    md: "# Title with \\* star",
    hasHardBreak: false,
  },
  {
    name: "bold containing underscore",
    md: "**bold \\_ text**",
    hasHardBreak: false,
  },
  {
    name: "italic containing underscore",
    md: "*italic \\_ text*",
    hasHardBreak: false,
  },
];

function parseJson(md: string): JsonContent {
  return markdownManager.parse(md);
}

function fragmentOf(json: JsonContent): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  prosemirrorJSONToYXmlFragment(schema, json, fragment);
  return fragment;
}

function isJsonContent(value: unknown): value is JsonContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function proseMirrorJsonOf(fragment: Y.XmlFragment): JsonContent {
  const json: unknown = yXmlFragmentToProseMirrorRootNode(
    fragment,
    schema,
  ).toJSON();
  if (!isJsonContent(json)) {
    throw new Error("The fragment did not convert to a document.");
  }
  return json;
}

function serialize(fragment: Y.XmlFragment): string {
  return jsonContentToArtifactMarkdown(proseMirrorJsonOf(fragment), OPTIONS);
}

function containsHardBreak(node: JsonContent): boolean {
  return (
    node.type === "hardBreak" ||
    (node.content ?? []).some((child) => containsHardBreak(child))
  );
}

function textOf(node: JsonContent): string {
  const own = node.text ?? "";
  const children = (node.content ?? []).map(textOf).join("\n");
  return own + children;
}

describe("artifact markdown escaping round trip (traycer#1563)", () => {
  describe.each(CORPUS)("$name", ({ md, hasHardBreak }) => {
    const json1 = parseJson(md);
    const fragment1 = fragmentOf(json1);
    const md1 = serialize(fragment1);
    const json2 = parseJson(md1);
    const fragment2 = fragmentOf(json2);
    const md2 = serialize(fragment2);

    it("is a fixed point after one pass", () => {
      expect(md2).toBe(md1);
    });

    it("re-ingesting the serialized markdown gives an identical Yjs document", () => {
      expect(fragment2.toJSON()).toBe(fragment1.toJSON());
      expect(proseMirrorJsonOf(fragment2)).toEqual(
        proseMirrorJsonOf(fragment1),
      );
    });

    it("parses a hard break node where the markdown has one", () => {
      expect(containsHardBreak(json1)).toBe(hasHardBreak);
      expect(containsHardBreak(json2)).toBe(hasHardBreak);
    });

    it("keeps the text content and leaks no escape backslash into it", () => {
      expect(textOf(json2)).toBe(textOf(json1));
    });
  });
});

/**
 * The parser keeps one to three spaces in front of a marker as paragraph text,
 * and the serializer keeps them, escaping the marker behind them. Four spaces
 * (or a tab) cannot be kept - written back they would be an indented code
 * block - so they are dropped once. A paragraph that opens the document loses
 * its spaces too, because `normalizeMarkdown` trims the whole document's start.
 */
describe("leading spaces before an escaped block marker", () => {
  it("keeps a later line's indent in front of the escaped marker, as a paragraph", () => {
    const json = parseJson("a\n  \\# h");
    expect((json.content ?? []).map((node) => node.type)).toEqual([
      "paragraph",
    ]);
    expect(textOf(json)).toBe("a\n  # h");
    expect(serialize(fragmentOf(json))).toBe("a\n  \\# h");
  });

  it("keeps a later paragraph's first-line indent, stable in one pass", () => {
    const json1 = parseJson("first\n\n  \\# h");
    expect((json1.content ?? []).map((node) => node.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(textOf(json1.content?.[1] ?? {})).toBe("  # h");
    expect(serialize(fragmentOf(json1))).toBe("first\n\n  \\# h");
  });

  it("drops the indent of a paragraph that opens the document, once, and is stable after", () => {
    const json1 = parseJson("  \\# h");
    expect(textOf(json1)).toBe("  # h");

    const md1 = serialize(fragmentOf(json1));
    expect(md1).toBe("\\# h");

    const json2 = parseJson(md1);
    expect((json2.content ?? []).map((node) => node.type)).toEqual([
      "paragraph",
    ]);
    expect(textOf(json2)).toBe("# h");
    expect(serialize(fragmentOf(json2))).toBe(md1);
  });

  it("drops the four-space indent of a later paragraph once, as a paragraph, and is stable after", () => {
    const paragraphOf = (value: string): JsonContent => ({
      type: "paragraph",
      content: [{ type: "text", text: value }],
    });
    const json1: JsonContent = {
      type: "doc",
      content: [paragraphOf("first"), paragraphOf("    code-looking")],
    };

    const md1 = serialize(fragmentOf(json1));
    expect(md1).toBe("first\n\ncode-looking");

    const json2 = parseJson(md1);
    expect((json2.content ?? []).map((node) => node.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(textOf(json2.content?.[1] ?? {})).toBe("code-looking");
    expect(serialize(fragmentOf(json2))).toBe(md1);
  });
});

/**
 * A hard break inside a list item is a backslash and newline, and the line
 * after it is the item's own text whatever it looks like: the item stays ONE
 * paragraph holding the hard break, never a nested list, quote, heading or
 * fence. Each document is built as JSON, written, parsed back and written
 * again; the parse must reproduce the original document exactly.
 */
type ItemKind =
  | "bullet"
  | "task"
  | "task-checked"
  | "ordered-1"
  | "ordered-10"
  | "ordered-100";

const ITEM_KINDS: ReadonlyArray<ItemKind> = [
  "bullet",
  "task",
  "task-checked",
  "ordered-1",
  "ordered-10",
  "ordered-100",
];

const LINES_AFTER_BREAK: ReadonlyArray<string> = [
  "- s",
  "1. s",
  "> q",
  "# h",
  "===",
  "```",
  "<div>",
  "Second",
  // One to three spaces before a marker are text, kept, with the marker escaped.
  "  - x",
  "  # x",
  "  > x",
];

function textParagraph(content: JsonContent[]): JsonContent {
  return content.length === 0
    ? { type: "paragraph" }
    : { type: "paragraph", content };
}

function plainText(value: string): JsonContent {
  return { type: "text", text: value };
}

function brokenParagraph(next: string): JsonContent {
  return textParagraph([
    plainText("First"),
    { type: "hardBreak" },
    plainText(next),
  ]);
}

/** A list of `kind` whose single item holds `content`. */
function listOf(kind: ItemKind, content: JsonContent[]): JsonContent {
  switch (kind) {
    case "bullet":
      return {
        type: "bulletList",
        content: [{ type: "listItem", content }],
      };
    case "task":
    case "task-checked":
      return {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: kind === "task-checked" },
            content,
          },
        ],
      };
    case "ordered-1":
    case "ordered-10":
    case "ordered-100":
      return {
        type: "orderedList",
        attrs: { start: Number(kind.slice("ordered-".length)), type: null },
        content: [{ type: "listItem", content }],
      };
  }
}

function hardBreakCount(node: JsonContent): number {
  return (
    (node.type === "hardBreak" ? 1 : 0) +
    (node.content ?? []).reduce((sum, child) => sum + hardBreakCount(child), 0)
  );
}

interface ListCase {
  readonly name: string;
  readonly doc: JsonContent;
  // How many hard breaks the document holds; the pass must keep every one.
  readonly breaks: number;
}

const LIST_CASES: ReadonlyArray<ListCase> = [
  ...ITEM_KINDS.flatMap((kind) =>
    LINES_AFTER_BREAK.map((line) => ({
      name: `${kind} item, line after the break ${JSON.stringify(line)}`,
      doc: { type: "doc", content: [listOf(kind, [brokenParagraph(line)])] },
      breaks: 1,
    })),
  ),
  // The same lines after a hard break in a top-level paragraph.
  ...LINES_AFTER_BREAK.map((line) => ({
    name: `paragraph, line after the break ${JSON.stringify(line)}`,
    doc: { type: "doc", content: [brokenParagraph(line)] },
    breaks: 1,
  })),
  // The same kinds nested once: a bullet item holding a nested list of that
  // kind, with the hard break in the nested item.
  ...ITEM_KINDS.map((kind) => ({
    name: `${kind} item nested in a bullet item`,
    doc: {
      type: "doc",
      content: [
        listOf("bullet", [
          textParagraph([plainText("a")]),
          listOf(kind, [brokenParagraph("- s")]),
        ]),
      ],
    },
    breaks: 1,
  })),
  // traycer#2574 shape C: an item whose first line is empty, then a nested
  // list whose item has the hard break.
  ...ITEM_KINDS.map((kind) => ({
    name: `${kind} item nested in an item with an empty first line`,
    doc: {
      type: "doc",
      content: [
        listOf("bullet", [
          textParagraph([]),
          listOf(kind, [brokenParagraph("- s")]),
        ]),
      ],
    },
    breaks: 1,
  })),
  // Control for shape C: the same empty-first-line item with no hard break.
  {
    name: "bullet item nested in an item with an empty first line, no hard break",
    doc: {
      type: "doc",
      content: [
        listOf("bullet", [
          textParagraph([]),
          listOf("bullet", [textParagraph([plainText("s")])]),
        ]),
      ],
    },
    breaks: 0,
  },
  // traycer#2574 shape E: an ordered list under a bullet item, under a task
  // item, and a task list under an ordered item holding an ordered list, with
  // the hard break in the innermost item.
  {
    name: "ordered item under a bullet item",
    doc: {
      type: "doc",
      content: [
        listOf("bullet", [
          textParagraph([plainText("a")]),
          listOf("ordered-1", [brokenParagraph("- s")]),
        ]),
      ],
    },
    breaks: 1,
  },
  {
    name: "ordered item under a task item",
    doc: {
      type: "doc",
      content: [
        listOf("task", [
          textParagraph([plainText("a")]),
          listOf("ordered-1", [brokenParagraph("- s")]),
        ]),
      ],
    },
    breaks: 1,
  },
  {
    name: "ordered item under a task item inside an ordered item",
    doc: {
      type: "doc",
      content: [
        listOf("ordered-10", [
          textParagraph([plainText("a")]),
          listOf("task", [
            textParagraph([plainText("b")]),
            listOf("ordered-100", [brokenParagraph("1. s")]),
          ]),
        ]),
      ],
    },
    breaks: 1,
  },
  // Control: the same nesting with no hard break at all.
  {
    name: "ordered item under a task item inside an ordered item, no hard break",
    doc: {
      type: "doc",
      content: [
        listOf("ordered-10", [
          textParagraph([plainText("a")]),
          listOf("task", [
            textParagraph([plainText("b")]),
            listOf("ordered-100", [textParagraph([plainText("c")])]),
          ]),
        ]),
      ],
    },
    breaks: 0,
  },
];

describe("a hard break inside a list item keeps its next line as text (traycer#1563)", () => {
  describe.each(LIST_CASES)("$name", ({ doc, breaks }) => {
    const fragment0 = fragmentOf(doc);
    const md1 = serialize(fragment0);
    const json1 = parseJson(md1);
    const fragment1 = fragmentOf(json1);
    const md2 = serialize(fragment1);
    const json2 = parseJson(md2);
    const fragment2 = fragmentOf(json2);

    it("is a fixed point over two passes", () => {
      expect(md2).toBe(md1);
      expect(serialize(fragment2)).toBe(md1);
    });

    it("parses back to the identical Yjs document", () => {
      expect(proseMirrorJsonOf(fragment1)).toEqual(
        proseMirrorJsonOf(fragment0),
      );
      expect(fragment1.toJSON()).toBe(fragment0.toJSON());
      expect(proseMirrorJsonOf(fragment2)).toEqual(
        proseMirrorJsonOf(fragment0),
      );
    });

    it("keeps the text and the hard break, with no escape backslash in the text", () => {
      expect(textOf(json1)).toBe(textOf(proseMirrorJsonOf(fragment0)));
      // The input must survive the schema, or the pass proves nothing.
      expect(hardBreakCount(proseMirrorJsonOf(fragment0))).toBe(breaks);
      expect(hardBreakCount(json1)).toBe(breaks);
    });
  });
});

/**
 * An item whose first paragraph is empty is written as an empty marker line.
 * Markdown cannot tell that from an item that simply starts with a blank line,
 * so the parse drops the empty paragraph: the document changes once, then is
 * stable. What must hold is that the next paragraph, whose text would open a
 * block, stays that item's text.
 */
describe("an item with an empty first paragraph keeps a block-looking second paragraph as text (traycer#1563)", () => {
  const kinds = [
    "bullet",
    "task",
    "ordered-1",
    "ordered-10",
    "ordered-100",
  ] as const;
  const lines = ["# h", "- s", "> q"] as const;
  const cases = kinds.flatMap((kind) =>
    lines.map((line) => [kind, line] as const),
  );

  function typesOf(node: JsonContent): string[] {
    return [node.type ?? "", ...(node.content ?? []).flatMap(typesOf)];
  }

  it.each(cases)("%s item, then %j", (kind, line) => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        listOf(kind, [textParagraph([]), textParagraph([plainText(line)])]),
      ],
    };
    const md1 = serialize(fragmentOf(doc));
    const json1 = parseJson(md1);
    const types = typesOf(json1);

    // The line is the item's text, not a heading, quote or nested list.
    expect(textOf(json1)).toBe(line);
    expect(types.filter((type) => type === "paragraph")).toHaveLength(1);
    expect(types).not.toContain("heading");
    expect(types).not.toContain("blockquote");
    expect(
      types.filter((type) => type === "bulletList" || type === "orderedList"),
    ).toHaveLength(kind.startsWith("task") ? 0 : 1);

    // The empty paragraph is dropped once; from then on it is stable.
    const md2 = serialize(fragmentOf(json1));
    const md3 = serialize(fragmentOf(parseJson(md2)));
    expect(md3).toBe(md2);
  });
});

describe("a hard break in an ordered item writes the next line at the content column (traycer#1563)", () => {
  it.each([
    ["ordered-1", "1. First\\\n   Second"],
    ["ordered-10", "10. First\\\n    Second"],
    ["ordered-100", "100. First\\\n     Second"],
  ] as const)("%s", (kind, expected) => {
    const doc: JsonContent = {
      type: "doc",
      content: [listOf(kind, [brokenParagraph("Second")])],
    };
    expect(serialize(fragmentOf(doc))).toBe(expected);
  });
});

describe("an indented code block after an empty task item line (traycer#2574)", () => {
  it("stays a code block over two passes", () => {
    const md0 = "- [ ] \n      code";
    const json1 = parseJson(md0);
    const fragment1 = fragmentOf(json1);
    const md1 = serialize(fragment1);
    const json2 = parseJson(md1);
    const fragment2 = fragmentOf(json2);

    const codeBlocksOf = (node: JsonContent): string[] =>
      (node.type === "codeBlock" ? [textOf(node)] : []).concat(
        (node.content ?? []).flatMap(codeBlocksOf),
      );
    expect(codeBlocksOf(json1)).toEqual(["code"]);
    expect(codeBlocksOf(json2)).toEqual(["code"]);
    expect(serialize(fragment2)).toBe(md1);
    expect(proseMirrorJsonOf(fragment2)).toEqual(proseMirrorJsonOf(fragment1));
  });
});

/**
 * Paragraph TEXT that would open a block if it were written raw: whatever the
 * position, the serializer must escape it so the parse reads the same text in
 * the same paragraph. Each row builds the document as JSON, writes it, parses
 * it back and checks the parse reproduces the original document exactly
 * (identical Yjs), then that a second pass writes the same markdown.
 *
 * One normalization is by design: four or more leading spaces cannot be kept
 * at a paragraph's start (written back they would open an indented code
 * block, and the parser does not decode entities to protect them), nor on the
 * line after a hard break inside a list item (the item's parser drops them).
 * That whitespace is dropped once; the text keeps everything else, stays a
 * paragraph, and the markdown is stable from the first pass. The line after a
 * hard break in a top-level paragraph keeps its spaces as text.
 */
const BLOCK_OPENING_TEXTS: ReadonlyArray<string> = [
  "# h",
  "> q",
  "---",
  "```js",
  "    code",
  "1. x",
  "- x",
  "<div>",
];

interface ClassCase {
  readonly name: string;
  readonly text: string;
  readonly doc: JsonContent;
  // True when leading whitespace of four or more columns cannot be kept here.
  readonly dropsIndentedCodeStart: boolean;
}

/** `- plain` and `- [ ] task` in one list, with `text` in each item. */
function mixedListDoc(text: string): JsonContent {
  const parsed = parseJson("- plain\n- [ ] task");
  const swap = (node: JsonContent): JsonContent => {
    if (node.type === "text") {
      return { ...node, text };
    }
    return node.content === undefined
      ? node
      : { ...node, content: node.content.map(swap) };
  };
  return swap(parsed);
}

const CLASS_CASES: ReadonlyArray<ClassCase> = BLOCK_OPENING_TEXTS.flatMap(
  (text) => {
    const label = JSON.stringify(text);
    const make = (
      name: string,
      doc: JsonContent,
      dropsIndentedCodeStart: boolean,
    ): ClassCase => ({
      name: `${name}, ${label}`,
      text,
      doc,
      dropsIndentedCodeStart,
    });
    return [
      make(
        "top-level paragraph",
        { type: "doc", content: [textParagraph([plainText(text)])] },
        true,
      ),
      make(
        "top-level later paragraph",
        {
          type: "doc",
          content: [
            textParagraph([plainText("first")]),
            textParagraph([plainText(text)]),
          ],
        },
        true,
      ),
      make(
        "line after a hard break",
        {
          type: "doc",
          content: [brokenParagraph(text)],
        },
        false,
      ),
      ...ITEM_KINDS.flatMap((kind) => [
        make(
          `${kind} item, first paragraph`,
          {
            type: "doc",
            content: [listOf(kind, [textParagraph([plainText(text)])])],
          },
          true,
        ),
        make(
          `${kind} item, later paragraph`,
          {
            type: "doc",
            content: [
              listOf(kind, [
                textParagraph([plainText("a")]),
                textParagraph([plainText(text)]),
              ]),
            ],
          },
          true,
        ),
        make(
          `${kind} item, line after a hard break`,
          { type: "doc", content: [listOf(kind, [brokenParagraph(text)])] },
          true,
        ),
      ]),
      make("mixed plain and task items", mixedListDoc(text), true),
    ];
  },
);

/** `doc` with every text node equal to `text` cut to `replacement`. */
function withText(
  doc: JsonContent,
  text: string,
  replacement: string,
): JsonContent {
  if (doc.type === "text" && doc.text === text) {
    return { ...doc, text: replacement };
  }
  return doc.content === undefined
    ? doc
    : {
        ...doc,
        content: doc.content.map((c) => withText(c, text, replacement)),
      };
}

describe("paragraph text that would open a block stays text (traycer#1563)", () => {
  it.each(CLASS_CASES)("$name", ({ text, doc, dropsIndentedCodeStart }) => {
    const fragment0 = fragmentOf(doc);
    const md1 = serialize(fragment0);
    const json1 = parseJson(md1);
    const fragment1 = fragmentOf(json1);
    const md2 = serialize(fragment1);

    // Stable from the first pass, always.
    expect(md2).toBe(md1);

    // Where four or more leading spaces cannot be kept, the text is read back
    // without them, in the same structure: no code block, no new block.
    const expected =
      dropsIndentedCodeStart && /^[ \t]{4}/.test(text)
        ? fragmentOf(withText(doc, text, text.trimStart()))
        : fragment0;
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(expected));
    expect(fragment1.toJSON()).toBe(expected.toJSON());
    expect(textOf(json1)).toBe(textOf(proseMirrorJsonOf(expected)));
  });
});

/**
 * Whitespace dropped on the line after a hard break inside a list item: the
 * item's parser drops four or more columns there, so the serializer writes
 * none, and the first pass is already the fixed point.
 */
describe("the line after a hard break in a list item drops four or more leading columns (traycer#1563)", () => {
  const cases = [
    ["bullet", "    code", "- First\\\n  code"],
    ["ordered-10", "    code", "10. First\\\n    code"],
    ["bullet", "     x", "- First\\\n  x"],
    ["bullet", "    # h", "- First\\\n  \\# h"],
  ] as const;

  it.each(cases)("%s item, %j", (kind, line, expected) => {
    const doc: JsonContent = {
      type: "doc",
      content: [listOf(kind, [brokenParagraph(line)])],
    };
    const md1 = serialize(fragmentOf(doc));
    expect(md1).toBe(expected);

    const json1 = parseJson(md1);
    expect(serialize(fragmentOf(json1))).toBe(md1);
    // Read back as text, after the hard break, in the same paragraph.
    const trimmed = withText(doc, line, line.trimStart());
    expect(proseMirrorJsonOf(fragmentOf(json1))).toEqual(
      proseMirrorJsonOf(fragmentOf(trimmed)),
    );
  });
});
