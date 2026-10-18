import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  jsonContentToArtifactMarkdown,
  unresolvedArtifactImageText,
  type ArtifactImage,
} from "@traycer/protocol/common/json-content-serializer";
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

/**
 * The artifact reader's own parse of `md` as a whole artifact body: the image
 * when the body is exactly one image, `null` otherwise. This is the real
 * parser the disk mirror reads artifacts back with, handed to the serializer
 * so it never carries a copy of the grammar.
 */
function readImage(md: string): ArtifactImage | null {
  const blocks = parseJson(md).content ?? [];
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (only === undefined) return null;
  const inner =
    only.type === "paragraph" && only.content?.length === 1
      ? only.content[0]
      : only;
  if (inner.type !== "image") return null;
  const alt = inner.attrs?.alt;
  const src = inner.attrs?.src;
  return {
    alt: typeof alt === "string" ? alt : "",
    src: typeof src === "string" ? src : "",
  };
}

/**
 * The ingest's stored document for `md`: the parse and then the Yjs
 * conversion, which is where the schema drops a node it does not allow. This
 * is the reader handed to the serializer, so what it keeps is what the
 * ingest keeps.
 */
function read(md: string): JsonContent {
  return proseMirrorJsonOf(fragmentOf(parseJson(md)));
}

function serializeJson(content: JsonContent): string {
  return jsonContentToArtifactMarkdown(content, OPTIONS);
}

function serialize(fragment: Y.XmlFragment): string {
  return serializeJson(proseMirrorJsonOf(fragment));
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
 * (or a tab) cannot be kept at a paragraph's start - written back they would
 * be an indented code block - so they are dropped once there. A paragraph that
 * opens the document keeps its one to three spaces: only line breaks are
 * trimmed at the document's start.
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

  it("keeps the indent of a paragraph that opens the document, and is stable", () => {
    const json1 = parseJson("  \\# h");
    expect(textOf(json1)).toBe("  # h");

    const md1 = serialize(fragmentOf(json1));
    expect(md1).toBe("  \\# h");

    const json2 = parseJson(md1);
    expect((json2.content ?? []).map((node) => node.type)).toEqual([
      "paragraph",
    ]);
    expect(textOf(json2)).toBe("  # h");
    expect(serialize(fragmentOf(json2))).toBe(md1);
  });

  it.each([
    [" code", " code"],
    ["  code", "  code"],
    ["   code", "   code"],
    [" # h", " \\# h"],
    ["  # h", "  \\# h"],
    ["   # h", "   \\# h"],
  ] as const)(
    "reads %j at the start of the document back as exactly that, from exactly %j",
    (value, expectedMd) => {
      const doc: JsonContent = {
        type: "doc",
        content: [textParagraph([plainText(value)])],
      };
      const fragment0 = fragmentOf(doc);
      const md1 = serialize(fragment0);
      expect(md1).toBe(expectedMd);

      const json1 = parseJson(md1);
      expect(textOf(json1)).toBe(value);
      const fragment1 = fragmentOf(json1);
      expect(proseMirrorJsonOf(fragment1)).toEqual(
        proseMirrorJsonOf(fragment0),
      );
      expect(fragment1.toJSON()).toBe(fragment0.toJSON());
      expect(serialize(fragment1)).toBe(md1);
    },
  );

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
 * block, and the parser does not decode entities to protect them). That
 * whitespace is dropped once; the text keeps everything else, stays a
 * paragraph, and the markdown is stable from the first pass. A later line of a
 * paragraph keeps its spaces, after a hard break in a top-level paragraph and
 * in a list item alike.
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
  // True when leading whitespace of four or more columns cannot be kept here:
  // at a paragraph's start, where it would open an indented code block.
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
          false,
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
    // as the literal `code`, in the same structure: no code block, no new
    // block. The only text with such spaces in the list is `    code`.
    const dropped = dropsIndentedCodeStart && /^[ \t]{4}/.test(text);
    if (dropped) expect(text).toBe("    code");
    const expected = dropped
      ? fragmentOf(withText(doc, text, "code"))
      : fragment0;
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(expected));
    expect(fragment1.toJSON()).toBe(expected.toJSON());
    expect(textOf(json1)).toBe(textOf(proseMirrorJsonOf(expected)));
  });
});

/**
 * The line after a hard break inside a list item keeps every leading column:
 * the item's parser takes exactly four columns off a line indented four or
 * more past its content column, so the serializer writes four extra spaces in
 * front and the text reads back exactly as it was, in the same paragraph.
 */
describe("the line after a hard break in a list item keeps four or more leading columns (traycer#1563)", () => {
  const cases = [
    ["bullet", "    code", "- First\\\n" + " ".repeat(10) + "code"],
    ["ordered-10", "    code", "10. First\\\n" + " ".repeat(12) + "code"],
    ["task", "    code", "- [ ] First\\\n" + " ".repeat(10) + "code"],
    ["bullet", "     x", "- First\\\n" + " ".repeat(11) + "x"],
    ["bullet", "    # h", "- First\\\n" + " ".repeat(10) + "# h"],
  ] as const;

  it.each(cases)("%s item, %j", (kind, line, expected) => {
    const doc: JsonContent = {
      type: "doc",
      content: [listOf(kind, [brokenParagraph(line)])],
    };
    const fragment0 = fragmentOf(doc);
    const md1 = serialize(fragment0);
    expect(md1).toBe(expected);

    const json1 = parseJson(md1);
    const fragment1 = fragmentOf(json1);
    expect(serialize(fragment1)).toBe(md1);
    // Read back as the same text, after the hard break, in the same paragraph.
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(fragment0));
    expect(fragment1.toJSON()).toBe(fragment0.toJSON());
    // `textOf` joins the paragraph's inline nodes with a line break, and the
    // hard break node is one of them.
    expect(textOf(json1)).toBe(`First\n\n${line}`);
  });

  // A tab is the one thing here that is not kept: the item's parser expands it
  // to the four columns it spans, so the text reads back as four spaces. That
  // is one pass; the markdown it then writes is the four-space form above.
  it("reads a tab after a hard break in a bullet item back as four spaces, once", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [listOf("bullet", [brokenParagraph("\tcode")])],
    };
    const md1 = serialize(fragmentOf(doc));
    expect(md1).toBe("- First\\\n" + " ".repeat(6) + "\tcode");

    const json1 = parseJson(md1);
    expect(textOf(json1)).toBe("First\n\n    code");
    const md2 = serialize(fragmentOf(json1));
    expect(md2).toBe("- First\\\n" + " ".repeat(10) + "code");

    const json2 = parseJson(md2);
    expect(textOf(json2)).toBe("First\n\n    code");
    expect(serialize(fragmentOf(json2))).toBe(md2);
  });
});

/**
 * Four spaces (or a tab) at a paragraph's start are dropped once, and the
 * expectations here are literals: the markdown as written, and the text as
 * read back. Written raw, the same spaces are an indented code block, and an
 * entity for the first space is not decoded by the parser, so there is no
 * escape that keeps them.
 */
describe("four leading spaces at a paragraph's start are dropped once (traycer#1563)", () => {
  const rows = [
    ["a document's first paragraph", "    code", [], "code"],
    ["a document's first paragraph, a tab", "\tcode", [], "code"],
    ["a later paragraph", "    code", ["first"], "first\n\ncode"],
  ] as const;

  it.each(rows)("%s, %j", (_name, value, before, expectedMd) => {
    const paragraphs = [...before, value].map((text) =>
      textParagraph([plainText(text)]),
    );
    const md1 = serialize(fragmentOf({ type: "doc", content: paragraphs }));
    expect(md1).toBe(expectedMd);

    const json1 = parseJson(md1);
    expect(json1.content?.at(-1)?.type).toBe("paragraph");
    expect(textOf(json1.content?.at(-1) ?? {})).toBe("code");
    expect(serialize(fragmentOf(json1))).toBe(md1);
  });

  it("drops them in a bullet item's first paragraph, with the literal bytes", () => {
    const md1 = serialize(
      fragmentOf({
        type: "doc",
        content: [listOf("bullet", [textParagraph([plainText("    code")])])],
      }),
    );
    expect(md1).toBe("- code");
    expect(textOf(parseJson(md1))).toBe("code");
  });

  it("drops them in a bullet item's later paragraph, with the literal bytes", () => {
    const md1 = serialize(
      fragmentOf({
        type: "doc",
        content: [
          listOf("bullet", [
            textParagraph([plainText("a")]),
            textParagraph([plainText("    code")]),
          ]),
        ],
      }),
    );
    expect(md1).toBe("- a\n\n  code");
    expect(
      textOf(parseJson(md1).content?.[0]?.content?.[0]?.content?.[1] ?? {}),
    ).toBe("code");
  });

  const typesOf = (node: JsonContent): string[] =>
    (node.type === undefined ? [] : [node.type]).concat(
      (node.content ?? []).flatMap(typesOf),
    );

  it("shows why: written raw, they open a code block", () => {
    const json = parseJson("    code");
    expect(typesOf(json)).toContain("codeBlock");
    expect(typesOf(json)).not.toContain("paragraph");
    expect(textOf(json)).toBe("code");
  });

  it("shows why: an entity for the first space is not decoded, it stays literal text", () => {
    const json = parseJson("&#32;   code");
    expect(typesOf(json)).not.toContain("codeBlock");
    expect(textOf(json)).toBe("&#32;   code");
  });
});

/**
 * A hard break that ends a paragraph cannot be written in CommonMark: the
 * artifact form leaves it out, so the paragraph reads back without it. Before,
 * the trailing backslash read back as a literal one.
 */
describe("a trailing hard break is dropped (traycer#1563)", () => {
  it("drops the one that ends a paragraph", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [textParagraph([plainText("First"), { type: "hardBreak" }])],
    };
    const md1 = serialize(fragmentOf(doc));
    expect(md1).toBe("First");

    const json1 = parseJson(md1);
    expect(hardBreakCount(json1)).toBe(0);
    expect(textOf(json1)).toBe("First");
    expect(serialize(fragmentOf(json1))).toBe(md1);
  });

  it("keeps the one in the middle and drops the trailing one", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        textParagraph([
          plainText("a"),
          { type: "hardBreak" },
          plainText("b"),
          { type: "hardBreak" },
        ]),
      ],
    };
    const md1 = serialize(fragmentOf(doc));
    expect(md1).toBe("a\\\nb");

    const json1 = parseJson(md1);
    expect(hardBreakCount(json1)).toBe(1);
    expect(textOf(json1)).toBe("a\n\nb");
    expect(serialize(fragmentOf(json1))).toBe(md1);
  });
});

/**
 * An empty task item and an empty ordered item are written as a bare marker
 * line whose trailing space is kept through the trim. Inside a quote the line
 * sits behind `> `, and the kept space must still be written.
 */
describe("an empty list item marker inside a quote keeps its space (traycer#1563)", () => {
  const PLACEHOLDER = /[\uFDD0-\uFDEF\uE000-\uF8FF]/u;
  const emptyTask: JsonContent = {
    type: "taskList",
    content: [
      {
        type: "taskItem",
        attrs: { checked: false },
        content: [{ type: "paragraph" }],
      },
    ],
  };
  const emptyOrdered: JsonContent = {
    type: "orderedList",
    attrs: { start: 10, type: null },
    content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
  };
  const quote = (inner: JsonContent): JsonContent => ({
    type: "blockquote",
    content: [inner],
  });
  const typesOf = (node: JsonContent): string[] =>
    (node.type === undefined ? [] : [node.type]).concat(
      (node.content ?? []).flatMap(typesOf),
    );

  const rows: ReadonlyArray<readonly [string, JsonContent, string]> = [
    ["a task item in a quote", quote(emptyTask), "> - [ ] "],
    ["an ordered item in a quote", quote(emptyOrdered), "> 10. "],
    [
      "a task item in a quote after a paragraph in a list item",
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [textParagraph([plainText("a")]), quote(emptyTask)],
          },
        ],
      },
      "- a\n  > - [ ] ",
    ],
    [
      "an ordered item in a quote after a paragraph in a list item",
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [textParagraph([plainText("a")]), quote(emptyOrdered)],
          },
        ],
      },
      "- a\n  > 10. ",
    ],
  ];

  it.each(rows)("%s", (_name, block, expectedMd) => {
    const md1 = serialize(fragmentOf({ type: "doc", content: [block] }));
    expect(md1).toBe(expectedMd);
    expect(md1).not.toMatch(PLACEHOLDER);

    const json1 = parseJson(md1);
    expect(typesOf(json1)).toContain("blockquote");
    const fragment1 = fragmentOf(json1);
    const md2 = serialize(fragment1);
    expect(md2).toBe(md1);
    expect(md2).not.toMatch(PLACEHOLDER);
    const fragment2 = fragmentOf(parseJson(md2));
    expect(proseMirrorJsonOf(fragment2)).toEqual(proseMirrorJsonOf(fragment1));
  });
});

/**
 * A line that starts with `#` and no space is not a heading to marked's own
 * lexer, so after a list item it is a paragraph, not the item's text.
 */
describe("a hashtag line after a list item is a paragraph (traycer#1563)", () => {
  const md0 = "- a\n#not-a-heading";

  it("parses to a list holding a and then a paragraph", () => {
    const json = parseJson(md0);
    expect((json.content ?? []).map((node) => node.type)).toEqual([
      "bulletList",
      "paragraph",
    ]);
    expect(textOf(json.content?.[0] ?? {})).toBe("a");
    expect(textOf(json.content?.[1] ?? {})).toBe("#not-a-heading");
  });

  it("round-trips through the JSON serializer as the same text", () => {
    const json1 = parseJson(md0);
    const fragment1 = fragmentOf(json1);
    const md1 = serialize(fragment1);
    const json2 = parseJson(md1);
    expect((json2.content ?? []).map((node) => node.type)).toEqual([
      "bulletList",
      "paragraph",
    ]);
    expect(textOf(json2.content?.[1] ?? {})).toBe("#not-a-heading");
    const fragment2 = fragmentOf(json2);
    expect(serialize(fragment2)).toBe(md1);
    expect(proseMirrorJsonOf(fragment2)).toEqual(proseMirrorJsonOf(fragment1));
  });
});

/**
 * An unresolved image's source text stays raw only where the parser reads it
 * back as one image. Deeper nesting is read as plain text whether it is raw or
 * escaped, so escaping it costs no retry.
 */
describe("raw image alt nesting (traycer#1563)", () => {
  // `a` followed by `depth` levels of `[b...]`.
  const alt = (depth: number): string => {
    let value = "a";
    for (let level = 0; level < depth; level++) {
      value = `a[b${value.slice(1)}]`;
    }
    return value;
  };
  const typesOf = (node: JsonContent): string[] =>
    (node.type === undefined ? [] : [node.type]).concat(
      (node.content ?? []).flatMap(typesOf),
    );

  it.each([0, 1])("reads an alt nested %i levels deep as an image", (depth) => {
    expect(typesOf(parseJson(`![${alt(depth)}](x)`))).toContain("image");
  });

  it.each([2, 3, 4, 5])(
    "reads an alt nested %i levels deep, written raw, as a paragraph of text",
    (depth) => {
      const md = `![${alt(depth)}](x)`;
      const json = parseJson(md);
      expect(typesOf(json)).not.toContain("image");
      expect((json.content ?? []).map((node) => node.type)).toEqual([
        "paragraph",
      ]);
      expect(textOf(json)).toBe(md);
    },
  );

  it.each([2, 3, 4, 5])(
    "escapes the text at depth %i and reads the escaped form back as the same text",
    (depth) => {
      const md = `![${alt(depth)}](x)`;
      const doc: JsonContent = {
        type: "doc",
        content: [textParagraph([plainText(md)])],
      };
      const md1 = serialize(fragmentOf(doc));
      expect(md1).not.toBe(md);
      const json1 = parseJson(md1);
      expect(typesOf(json1)).not.toContain("image");
      expect(textOf(json1)).toBe(md);
      expect(serialize(fragmentOf(json1))).toBe(md1);
    },
  );

  it.each(["![a \\] b](x)", "![a `]` b](x)"])(
    "reads %s back as an image",
    (md) => {
      expect(typesOf(parseJson(md))).toContain("image");
    },
  );

  it("escapes an image followed by a link, and reads the text back unchanged", () => {
    const md = "![x](a) [y](b)";
    const doc: JsonContent = {
      type: "doc",
      content: [textParagraph([plainText(md)])],
    };
    const md1 = serialize(fragmentOf(doc));
    expect(md1).toBe("!\\[x](a) \\[y](b)");
    expect(textOf(parseJson(md1))).toBe(md);
  });
});

/**
 * Spaces and tabs that end a paragraph line are dropped by CommonMark, and two
 * or more before a line break would read as a hard break, so the artifact form
 * drops them once. Before a written hard break the backslash holds them.
 */
describe("trailing spaces at the end of a paragraph (traycer#1563)", () => {
  it("drops them from the end of a paragraph, once", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [textParagraph([plainText("code  ")])],
    };
    const md1 = serialize(fragmentOf(doc));
    expect(md1).toBe("code");

    const json1 = parseJson(md1);
    expect(textOf(json1)).toBe("code");
    expect(serialize(fragmentOf(json1))).toBe(md1);
  });

  it("keeps the spaces in front of a hard break", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        textParagraph([
          plainText("First  "),
          { type: "hardBreak" },
          plainText("x"),
        ]),
      ],
    };
    const fragment0 = fragmentOf(doc);
    const md1 = serialize(fragment0);
    expect(md1).toBe("First  \\\nx");

    const json1 = parseJson(md1);
    expect(hardBreakCount(json1)).toBe(1);
    const fragment1 = fragmentOf(json1);
    expect(serialize(fragment1)).toBe(md1);
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(fragment0));
    expect(textOf(json1)).toBe("First  \n\nx");
  });

  it("writes a paragraph of only whitespace as an empty document", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [textParagraph([plainText("    ")])],
    };
    expect(serialize(fragmentOf(doc))).toBe("");
  });
});

/**
 * Unmarked text of only spaces and tabs renders as nothing, so a hard break
 * before it ends the paragraph's text all the same and is dropped with it.
 */
describe("a trailing hard break followed by only whitespace is dropped (traycer#1563)", () => {
  const rows = [
    ["a, break, a space", ["a", "HB", " "], "a", 0],
    ["a, break, a tab", ["a", "HB", "\t"], "a", 0],
    ["a, break, b, break, a space", ["a", "HB", "b", "HB", " "], "a\\\nb", 1],
  ] as const;

  it.each(rows)("%s", (_name, parts, expectedMd, breaks) => {
    const content = parts.map((part) =>
      part === "HB" ? { type: "hardBreak" } : plainText(part),
    );
    const md1 = serialize(
      fragmentOf({ type: "doc", content: [textParagraph(content)] }),
    );
    expect(md1).toBe(expectedMd);

    const json1 = parseJson(md1);
    expect(hardBreakCount(json1)).toBe(breaks);
    const fragment1 = fragmentOf(json1);
    expect(serialize(fragment1)).toBe(md1);
  });
});

/**
 * What the host writes for an image it cannot resolve yet is
 * `unresolvedArtifactImageText(alt, src)`. The serializer keeps that text
 * raw exactly when the artifact reader itself parses it as one image whose
 * own text it is, so the next read retries the image; otherwise the text is
 * escaped and reads back as the same text. Each row is generated the way the
 * host builds its text, and the expectations are what the real parser says.
 */
describe("unresolved image text: the reader decides (traycer#1563)", () => {
  interface ImageRow {
    readonly name: string;
    readonly alt: string;
    readonly src: string;
    // Whether the real parser reads the host's text for this alt and source as
    // one image at all.
    readonly readsAsImage: boolean;
    // Whether that image's own text is the host's text, so it stays raw.
    readonly verbatim: boolean;
  }

  const rows: readonly ImageRow[] = [
    {
      name: "a double-backtick code span holding a bracket (the review case)",
      alt: "a ``]`` b",
      src: "images/missing.png",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "a triple-backtick code span holding a bracket",
      alt: "a ```]``` b",
      src: "images/missing.png",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "an alt that is a code span",
      alt: "`x`",
      src: "images/missing.png",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "a single-backtick code span holding a bracket",
      alt: "a `]` b",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "a backslash-escaped closing bracket, which the parser reads as a bare one",
      alt: "a \\] b",
      src: "x",
      readsAsImage: false,
      verbatim: false,
    },
    {
      name: "a backslash-escaped opening bracket, which the parser reads as a bare one",
      alt: "a \\[ b",
      src: "x",
      readsAsImage: false,
      verbatim: false,
    },
    {
      name: "a doubled backslash, which the parser keeps",
      alt: "a \\\\ b",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "brackets nested 0 levels deep",
      alt: "a",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "brackets nested 1 level deep",
      alt: "a[b]",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "brackets nested 2 levels deep",
      alt: "a[b[b]]",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "brackets nested 3 levels deep",
      alt: "a[b[b[b]]]",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "an empty alt",
      alt: "",
      src: "x",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "a source with a space, bracketed",
      alt: "a",
      src: "images/a b.png",
      readsAsImage: true,
      verbatim: true,
    },
    {
      name: "a source with parentheses, bracketed",
      alt: "a",
      src: "x(1).png",
      readsAsImage: true,
      verbatim: true,
    },
  ];

  const imageTypeIn = (node: JsonContent): boolean =>
    node.type === "image" || (node.content ?? []).some(imageTypeIn);

  it.each(rows)("$name", (row) => {
    const text = unresolvedArtifactImageText(row.alt, row.src);
    const fragment0 = fragmentOf({
      type: "doc",
      content: [textParagraph([plainText(text)])],
    });

    // What the real parser says about the host's text, as a whole body.
    expect(readImage(text) !== null).toBe(row.readsAsImage);

    const md1 = serialize(fragment0);
    const json1 = parseJson(md1);
    const fragment1 = fragmentOf(json1);
    const md2 = serialize(fragment1);

    if (row.verbatim) {
      // Kept raw, and read as an image again: the retry. The document is an
      // image from here on.
      expect(md1).toBe(text);
      expect(imageTypeIn(json1)).toBe(true);
      expect(readImage(md1)).toEqual({ alt: row.alt, src: row.src });
    } else {
      // Escaped, and read back as the same text in the same paragraph, stable
      // from the first pass.
      expect(md1).not.toBe(text);
      expect(md2).toBe(md1);
      expect(imageTypeIn(json1)).toBe(false);
      expect(textOf(json1)).toBe(text);
      expect(proseMirrorJsonOf(fragment1)).toEqual(
        proseMirrorJsonOf(fragment0),
      );
      expect(fragment1.toJSON()).toBe(fragment0.toJSON());
    }
  });

  it("reads the review case back as an image with the host's own alt and source", () => {
    const text = unresolvedArtifactImageText("a ``]`` b", "images/missing.png");
    expect(text).toBe("![a ``\\]`` b](images/missing.png)");
    expect(readImage(text)).toEqual({
      alt: "a ``]`` b",
      src: "images/missing.png",
    });
  });
});

/**
 * An image node must read back as itself. The reader does not undo every
 * escape the usual spelling writes (it keeps an escaped backslash in the alt as
 * both characters), so on the artifact path the reader picks the spelling: the
 * usual escaped one first, then brackets-only, then the host's own text.
 */
describe("an image node's alt round-trips through the artifact reader (traycer#1563)", () => {
  const alts: ReadonlyArray<readonly [string, string]> = [
    ["a backslash", "a \\ b"],
    ["a doubled backslash", "a \\\\ b"],
    ["no brackets", "a"],
    ["brackets one level deep", "a[b]"],
    ["a code span", "a `b` c"],
    ["a code span holding a bracket", "a ``]`` b"],
    ["an alt that is a code span", "`x`"],
    ["an empty alt", ""],
  ];
  const srcs: ReadonlyArray<readonly [string, string]> = [
    ["a plain source", "images/x.png"],
    ["a source with spaces", "images/a b.png"],
  ];
  const rows = alts.flatMap(([altName, alt]) =>
    srcs.map(([srcName, src]) => ({
      name: `${altName}, ${srcName}`,
      alt,
      src,
    })),
  );

  function imageDoc(alt: string, src: string): JsonContent {
    return { type: "doc", content: [{ type: "image", attrs: { src, alt } }] };
  }

  it.each(rows)("$name", ({ alt, src }) => {
    const fragment0 = fragmentOf(imageDoc(alt, src));
    const md1 = serialize(fragment0);

    const json1 = parseJson(md1);
    const fragment1 = fragmentOf(json1);
    // One pass, then re-ingest, gives the identical image and Yjs.
    expect(readImage(md1)).toEqual({ alt, src });
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(fragment0));
    expect(fragment1.toJSON()).toBe(fragment0.toJSON());
    // And a second pass writes the same bytes.
    expect(serialize(fragment1)).toBe(md1);
  });

  // Alts that already round-tripped keep their bytes: the usual escaped
  // spelling stays first.
  it.each([
    ["no brackets", "a", "images/x.png", "![a](images/x.png)"],
    ["an empty alt", "", "images/x.png", "![](images/x.png)"],
    [
      "brackets one level deep",
      "a[b]",
      "images/x.png",
      "![a\\[b\\]](images/x.png)",
    ],
    ["a source with spaces", "a", "images/a b.png", "![a](<images/a b.png>)"],
    ["a code span", "a `b` c", "images/x.png", "![a `b` c](images/x.png)"],
  ])("keeps the usual escaped bytes for %s", (_name, alt, src, expected) => {
    expect(serialize(fragmentOf(imageDoc(alt, src)))).toBe(expected);
  });
});

/**
 * A backslash directly before a `]`, or at the end of the alt, cannot be kept
 * by the reader: it keeps an escaped backslash as both characters and reads
 * `\]` as a bare bracket. No spelling reads back exactly, so the spelling
 * written is one whose read-back image is written with those same bytes again:
 * the alt changes once, and every pass after is identical.
 */
describe("an image alt the reader cannot keep changes once and is then stable (traycer#1563)", () => {
  const rows = [
    {
      name: "a trailing backslash",
      alt: "a \\",
      pass1: "![a \\\\](images/x.png)",
      readBackAlt: "a \\\\",
    },
    {
      name: "a backslash right before a closing bracket",
      alt: "a \\] b",
      pass1: "![a \\\\\\] b](images/x.png)",
      readBackAlt: "a \\\\] b",
    },
    {
      name: "a lone backtick",
      alt: "a ` b",
      pass1: "![a \\` b](images/x.png)",
      readBackAlt: "a \\` b",
    },
  ] as const;

  it.each(rows)("$name", ({ alt, pass1, readBackAlt }) => {
    const src = "images/x.png";
    const fragment0 = fragmentOf({
      type: "doc",
      content: [{ type: "image", attrs: { src, alt } }],
    });
    const md1 = serialize(fragment0);
    expect(md1).toBe(pass1);
    expect(readImage(md1)).toEqual({ alt: readBackAlt, src });

    const fragment1 = fragmentOf(parseJson(md1));
    const md2 = serialize(fragment1);
    expect(md2).toBe(pass1);

    const fragment2 = fragmentOf(parseJson(md2));
    expect(proseMirrorJsonOf(fragment2)).toEqual(proseMirrorJsonOf(fragment1));
    expect(fragment2.toJSON()).toBe(fragment1.toJSON());
    expect(serialize(fragment2)).toBe(pass1);
  });
});

/**
 * The reader decides, and it reads a label that spans lines: the fallback text
 * of an image with a newline in its alt is one image to the reader, so it is
 * kept raw and the image comes back on the next read. Text the reader does not
 * read as one image is escaped like any other text.
 */
describe("a multiline unresolved image label is the reader's call (traycer#1563)", () => {
  const imagesIn = (node: JsonContent): JsonContent[] =>
    (node.type === "image" ? [node] : []).concat(
      (node.content ?? []).flatMap(imagesIn),
    );
  const altsIn = (node: JsonContent): unknown[] =>
    imagesIn(node).map((image) => image.attrs?.alt);

  const readable = [
    { name: "one newline", alt: "a\nb", src: "images/missing.png" },
    { name: "two newlines", alt: "a\nb\nc", src: "images/missing.png" },
    {
      name: "a newline after brackets",
      alt: "a [x]\nb",
      src: "images/missing.png",
    },
    {
      name: "a newline after a backslash",
      alt: "a \\\nb",
      src: "images/missing.png",
    },
    {
      name: "a newline in the alt and a source with spaces",
      alt: "a\nb",
      src: "images/a b.png",
    },
  ] as const;

  it.each(readable)("$name: kept raw, and the image comes back", (row) => {
    const text = unresolvedArtifactImageText(row.alt, row.src);
    // The reader reads the whole text as one image whose fallback text it is.
    expect(readImage(text)).toEqual({ alt: row.alt, src: row.src });

    const fragment0 = fragmentOf({
      type: "doc",
      content: [textParagraph([plainText(text)])],
    });
    const md1 = serialize(fragment0);
    expect(md1).toBe(text);

    // The retry: the next read is the image.
    const json1 = parseJson(md1);
    expect(imagesIn(json1).map((image) => image.attrs)).toEqual([
      expect.objectContaining({ alt: row.alt, src: row.src }),
    ]);
    const fragment1 = fragmentOf(json1);
    expect(altsIn(proseMirrorJsonOf(fragment1))).toEqual([row.alt]);

    // From there on the image is a node, and its bytes settle.
    const md2 = serialize(fragment1);
    expect(readImage(md2)).toEqual({ alt: row.alt, src: row.src });
    expect(serialize(fragmentOf(parseJson(md2)))).toBe(md2);
  });

  const unreadable = [
    { name: "a heading line in the alt", alt: "a\n# b" },
    { name: "a bullet line in the alt", alt: "a\n- b" },
  ] as const;

  it.each(unreadable)(
    "$name: not one image, escaped, and read back as the same text",
    (row) => {
      const text = unresolvedArtifactImageText(row.alt, "images/missing.png");
      expect(readImage(text)).toBeNull();

      const fragment0 = fragmentOf({
        type: "doc",
        content: [textParagraph([plainText(text)])],
      });
      const md1 = serialize(fragment0);
      expect(md1).not.toBe(text);

      const json1 = parseJson(md1);
      expect(imagesIn(json1)).toEqual([]);
      expect(textOf(json1)).toBe(text);
      const fragment1 = fragmentOf(json1);
      expect(proseMirrorJsonOf(fragment1)).toEqual(
        proseMirrorJsonOf(fragment0),
      );
      expect(fragment1.toJSON()).toBe(fragment0.toJSON());
      expect(serialize(fragment1)).toBe(md1);
    },
  );

  // The reader reads this label as one image, but the decoder does not accept
  // it: a later line that starts with a backslash is not a line the decoder
  // proves a paragraph carries as written. The fallback stays text - the
  // retry is lost for this one alt, and the text round-trips exactly.
  it("writes a later line that starts with an escaped bracket as text, stable from the first pass", () => {
    const text = unresolvedArtifactImageText("a\n[b]", "images/missing.png");
    expect(text).toBe("![a\n\\[b\\]](images/missing.png)");
    const fragment0 = fragmentOf({
      type: "doc",
      content: [textParagraph([plainText(text)])],
    });
    const md1 = serialize(fragment0);
    expect(md1).toBe("!\\[a\n\\\\\\[b\\\\]](images/missing.png)");
    const json1 = parseJson(md1);
    expect(imagesIn(json1)).toEqual([]);
    expect(textOf(json1)).toBe(text);
    const fragment1 = fragmentOf(json1);
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(fragment0));
    expect(fragment1.toJSON()).toBe(fragment0.toJSON());
    expect(serialize(fragment1)).toBe(md1);
  });

  it("pins the escaped bytes of the two unreadable labels", () => {
    const bytes = (alt: string): string =>
      serialize(
        fragmentOf({
          type: "doc",
          content: [
            textParagraph([
              plainText(unresolvedArtifactImageText(alt, "images/missing.png")),
            ]),
          ],
        }),
      );
    expect(bytes("a\n# b")).toBe("!\\[a\n\\# b](images/missing.png)");
    expect(bytes("a\n- b")).toBe("!\\[a\n\\- b](images/missing.png)");
  });

  // The same fallback inside other blocks. It is written raw only where the
  // ingest keeps the image it reads there: the artifact image is a block
  // node, so where the parser puts it inside a paragraph (a bullet item) the
  // schema drops it, and the fallback is written as text instead. The ingest
  // is asked, not assumed: the stored document is what decides.
  describe("inside other blocks", () => {
    const fallback = (alt: string): string =>
      unresolvedArtifactImageText(alt, "images/missing.png");
    const imageNode = (alt: string): JsonContent => ({
      type: "image",
      attrs: { src: "images/missing.png", alt },
    });
    const wrap = {
      "the top level": (block: JsonContent): JsonContent => ({
        type: "doc",
        content: [block],
      }),
      "a bullet item": (block: JsonContent): JsonContent => ({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [block] }],
          },
        ],
      }),
      "an ordered item": (block: JsonContent): JsonContent => ({
        type: "doc",
        content: [
          {
            type: "orderedList",
            attrs: { start: 1, type: null },
            content: [{ type: "listItem", content: [block] }],
          },
        ],
      }),
      "a block quote": (block: JsonContent): JsonContent => ({
        type: "doc",
        content: [{ type: "blockquote", content: [block] }],
      }),
    };

    // The block after a first paragraph, which is where the readers keep the
    // image in a list item.
    const later =
      (list: "bullet" | "ordered" | "task") =>
      (block: JsonContent): JsonContent => {
        const lead = textParagraph([plainText("t")]);
        const item: JsonContent =
          list === "task"
            ? {
                type: "taskItem",
                attrs: { checked: false },
                content: [lead, block],
              }
            : { type: "listItem", content: [lead, block] };
        if (list === "bullet") {
          return {
            type: "doc",
            content: [{ type: "bulletList", content: [item] }],
          };
        }
        if (list === "ordered") {
          return {
            type: "doc",
            content: [
              {
                type: "orderedList",
                attrs: { start: 1, type: null },
                content: [item],
              },
            ],
          };
        }
        return {
          type: "doc",
          content: [{ type: "taskList", content: [item] }],
        };
      };
    const firstTask = (block: JsonContent): JsonContent => ({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [block] },
          ],
        },
      ],
    });
    const wraps = {
      ...wrap,
      "a bullet item's later block": later("bullet"),
      "an ordered item's later block": later("ordered"),
      "a task item's later block": later("task"),
      "a task item": firstTask,
    };

    const raw = [
      ["the top level", "a", "![a](images/missing.png)"],
      ["the top level", "a\nb", "![a\nb](images/missing.png)"],
      ["a block quote", "a", "> ![a](images/missing.png)"],
      ["a block quote", "a\nb", "> ![a\n> b](images/missing.png)"],
      ["a bullet item's later block", "a", "- t\n\n  ![a](images/missing.png)"],
      [
        "an ordered item's later block",
        "a",
        "1. t\n\n   ![a](images/missing.png)",
      ],
      [
        "an ordered item's later block",
        "a\nb",
        "1. t\n\n   ![a\n   b](images/missing.png)",
      ],
    ] as const;

    it.each(raw)(
      "%s, alt %j: both readers keep the image, so the fallback is written raw",
      (where, alt, md) => {
        const doc = wraps[where](textParagraph([plainText(fallback(alt))]));
        const md1 = serialize(fragmentOf(doc));
        expect(md1).toBe(md);
        // The stored document keeps the image, with its alt and source.
        expect(altsIn(read(md1))).toEqual([alt]);
        // Raw is the very bytes the image itself is written with there. A
        // paragraph after a sibling block is separated from it by a blank
        // line, which an image block is not.
        const sameBytes = where.includes("later block")
          ? md1.replace("\n\n", "\n")
          : md1;
        expect(sameBytes).toBe(serializeJson(wraps[where](imageNode(alt))));
      },
    );

    // An item's first block is read on its marker line, where the readers put
    // the image inside the paragraph and the schema drops it, or disagree.
    const asText = [
      ["a bullet item", "a", "- !\\[a](images/missing.png)"],
      ["a bullet item", "a\nb", "- !\\[a\n  b](images/missing.png)"],
      ["an ordered item", "a", "1. !\\[a](images/missing.png)"],
      ["an ordered item", "a\nb", "1. !\\[a\n   b](images/missing.png)"],
      ["a task item", "a", "- [ ] !\\[a](images/missing.png)"],
      [
        "a task item's later block",
        "a",
        "- [ ] t\n\n  !\\[a](images/missing.png)",
      ],
    ] as const;

    it.each(asText)(
      "%s, alt %j: the fallback is written as text and kept as text",
      (where, alt, md) => {
        const text = fallback(alt);
        const doc = wraps[where](textParagraph([plainText(text)]));
        const md1 = serialize(fragmentOf(doc));
        expect(md1).toBe(md);

        // The stored document keeps the fallback, as its text, and no image.
        const stored = read(md1);
        expect(imagesIn(stored)).toEqual([]);
        expect(textOf(stored).endsWith(text)).toBe(true);
        // And it is stable.
        expect(serializeJson(stored)).toBe(md1);
      },
    );

    it("writes the fallback in a bullet item as text while the same document's top-level one stays raw", () => {
      const doc: JsonContent = {
        type: "doc",
        content: [
          textParagraph([plainText(fallback("a"))]),
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [textParagraph([plainText(fallback("b"))])],
              },
            ],
          },
        ],
      };
      expect(serialize(fragmentOf(doc))).toBe(
        "![a](images/missing.png)\n\n- !\\[b](images/missing.png)",
      );
    });
  });

  describe("with a carriage return", () => {
    it("is read with the carriage return gone from the alt", () => {
      const read = readImage("![a\r\nb](images/missing.png)");
      expect(read).toEqual({ alt: "a\nb", src: "images/missing.png" });
      expect(read?.alt.includes("\r")).toBe(false);
    });

    it("escapes a fallback text node holding CRLF, which is not the text the reader reads, and then settles on the image", () => {
      const text = unresolvedArtifactImageText("a\r\nb", "images/missing.png");
      const md1 = serialize(
        fragmentOf({
          type: "doc",
          content: [textParagraph([plainText(text)])],
        }),
      );
      expect(md1).toBe("!\\[a\r\nb](images/missing.png)");
      const md2 = serialize(fragmentOf(parseJson(md1)));
      expect(md2).toBe("![a\nb](images/missing.png)");
      const md3 = serialize(fragmentOf(parseJson(md2)));
      expect(md3).toBe(md2);
    });

    it("writes an image node whose alt holds CRLF without the carriage return from the first pass", () => {
      let doc: JsonContent = {
        type: "doc",
        content: [
          { type: "image", attrs: { src: "images/x.png", alt: "a\r\nb" } },
        ],
      };
      const passes: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const md = serialize(fragmentOf(doc));
        passes.push(md);
        doc = parseJson(md);
      }
      expect(passes).toEqual([
        "![a\nb](images/x.png)",
        "![a\nb](images/x.png)",
        "![a\nb](images/x.png)",
        "![a\nb](images/x.png)",
      ]);
    });
  });

  describe("in a table cell", () => {
    const table = (text: string): JsonContent => ({
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
                  content: [textParagraph([plainText(text)])],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [textParagraph([plainText(text)])],
                },
              ],
            },
          ],
        },
      ],
    });
    const cellsOf = (node: JsonContent): JsonContent[] =>
      (node.type === "tableHeader" || node.type === "tableCell"
        ? [node]
        : []
      ).concat((node.content ?? []).flatMap(cellsOf));

    // The reader puts a cell's image inside a paragraph, which the schema
    // does not allow, so the ingest drops it: the fallback is written as text.
    it.each([
      ["a", "| !\\[a](images/x.png) |\n| --- |\n| !\\[a](images/x.png) |"],
      [
        "a|b",
        "| !\\[a\\|b](images/x.png) |\n| --- |\n| !\\[a\\|b](images/x.png) |",
      ],
      [
        "a\nb",
        "| !\\[a<br>b](images/x.png) |\n| --- |\n| !\\[a<br>b](images/x.png) |",
      ],
    ])(
      "writes the fallback of alt %j as text, because the ingest drops a cell's image",
      (alt, md) => {
        const md1 = serialize(
          fragmentOf(table(unresolvedArtifactImageText(alt, "images/x.png"))),
        );
        expect(md1).toBe(md);
        const stored = read(md1);
        expect(imagesIn(stored)).toEqual([]);
        // Both cells are still there, and the text is still in them.
        expect(cellsOf(stored)).toHaveLength(2);
        expect(serializeJson(stored)).toBe(md1);
      },
    );

    it.each(["a", "a|b"])(
      "keeps the cell's text for alt %j equal to the fallback text",
      (alt) => {
        const text = unresolvedArtifactImageText(alt, "images/x.png");
        const stored = read(serialize(fragmentOf(table(text))));
        expect(cellsOf(stored).map(textOf)).toEqual([text, text]);
      },
    );
  });
});

/**
 * The same cell, with `k` backslashes in front of a pipe in the alt, in the
 * header and in the body. The ingest drops a cell's image, so the fallback is
 * written as text; what must hold is that the table keeps its one column and
 * the cells read back as the text they had.
 */
describe("pipes after backslashes in a table cell's fallback text (traycer#1563)", () => {
  const bs = (count: number): string => "\\".repeat(count);
  const cellsOf = (node: JsonContent): JsonContent[] =>
    (node.type === "tableHeader" || node.type === "tableCell"
      ? [node]
      : []
    ).concat((node.content ?? []).flatMap(cellsOf));
  const rowsOf = (node: JsonContent): JsonContent[] =>
    (node.type === "tableRow" ? [node] : []).concat(
      (node.content ?? []).flatMap(rowsOf),
    );

  it.each([0, 1, 2, 3, 4])(
    "keeps the column and the text with %i backslashes before the pipe",
    (k) => {
      const text = unresolvedArtifactImageText(`a${bs(k)}|b`, "images/x.png");
      const doc: JsonContent = {
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
                    content: [textParagraph([plainText(text)])],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [textParagraph([plainText(text)])],
                  },
                ],
              },
            ],
          },
        ],
      };
      const fragment0 = fragmentOf(doc);
      const md1 = serialize(fragment0);
      const stored = read(md1);
      // One column in each of the two rows.
      expect(rowsOf(stored).map((row) => (row.content ?? []).length)).toEqual([
        1, 1,
      ]);
      // The text each cell held.
      expect(cellsOf(stored).map(textOf)).toEqual([text, text]);
      // And the document is the one that was written.
      const fragment1 = fragmentOf(parseJson(md1));
      expect(proseMirrorJsonOf(fragment1)).toEqual(
        proseMirrorJsonOf(fragment0),
      );
      expect(serialize(fragment1)).toBe(md1);
    },
  );
});

/**
 * An artifact heading is one line, so a hard break in it is written as `<br>`,
 * which the reader reads back as a hard break; a typed `<br>` is escaped and
 * reads back as text.
 */
describe("a hard break in a heading (traycer#1563)", () => {
  const hb: JsonContent = { type: "hardBreak" };
  const heading = (level: number, content: JsonContent[]): JsonContent => ({
    type: "doc",
    content: [{ type: "heading", attrs: { level }, content }],
  });
  const rows = [
    {
      name: "one break",
      doc: heading(1, [plainText("First"), hb, plainText("Second")]),
      md: "# First<br>Second",
    },
    {
      name: "two breaks",
      doc: heading(1, [plainText("a"), hb, plainText("b"), hb, plainText("c")]),
      md: "# a<br>b<br>c",
    },
    {
      name: "level 2",
      doc: heading(2, [plainText("First"), hb, plainText("Second")]),
      md: "## First<br>Second",
    },
    {
      name: "level 6",
      doc: heading(6, [plainText("First"), hb, plainText("Second")]),
      md: "###### First<br>Second",
    },
    {
      name: "a typed <br> in the text",
      doc: heading(1, [plainText("a<br>b")]),
      md: "# a\\<br>b",
    },
    {
      name: "a break followed by text starting with a heading marker",
      doc: heading(1, [plainText("First"), hb, plainText("# x")]),
      md: "# First<br># x",
    },
    {
      name: "a break followed by text starting with a bullet marker",
      doc: heading(1, [plainText("First"), hb, plainText("- x")]),
      md: "# First<br>- x",
    },
  ] as const;

  it.each(rows)("$name", ({ doc, md }) => {
    const fragment0 = fragmentOf(doc);
    const md1 = serialize(fragment0);
    expect(md1).toBe(md);

    const fragment1 = fragmentOf(parseJson(md1));
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(fragment0));
    expect(fragment1.toJSON()).toBe(fragment0.toJSON());
    expect(serialize(fragment1)).toBe(md1);
  });

  it("reads a break at the end of a heading, and settles", () => {
    const fragment0 = fragmentOf(heading(1, [plainText("First"), hb]));
    const md1 = serialize(fragment0);
    const fragment1 = fragmentOf(parseJson(md1));
    const md2 = serialize(fragment1);
    expect(md1).toBe("# First<br>");
    expect(md2).toBe(md1);
    expect(proseMirrorJsonOf(fragment1)).toEqual(proseMirrorJsonOf(fragment0));
  });
});

/**
 * A source holding `<`, `>` or a backslash is written in the bracketed
 * destination form with those escaped, and the reader reads the same source
 * back, so the retry works for it too.
 */
describe("an unresolved image whose source holds angle brackets or backslashes (traycer#1563)", () => {
  const rows = [
    ["images/a<b.png", "![a](<images/a\\<b.png>)"],
    ["images/a b>.png", "![a](<images/a b\\>.png>)"],
    ["images/a\\b.png", "![a](<images/a\\\\b.png>)"],
    ["images/a\\\\b c.png", "![a](<images/a\\\\\\\\b c.png>)"],
  ] as const;

  it.each(rows)("%j", (src, expectedText) => {
    const text = unresolvedArtifactImageText("a", src);
    expect(text).toBe(expectedText);
    expect(readImage(text)).toEqual({ alt: "a", src });

    const md1 = serialize(
      fragmentOf({ type: "doc", content: [textParagraph([plainText(text)])] }),
    );
    // Kept raw at the top level, and read back as the image with that source.
    expect(md1).toBe(text);
    expect(readImage(md1)).toEqual({ alt: "a", src });
    expect(imageSrcsIn(read(md1))).toEqual([src]);
  });

  function imageSrcsIn(node: JsonContent): unknown[] {
    return (node.type === "image" ? [node.attrs?.src] : []).concat(
      (node.content ?? []).flatMap(imageSrcsIn),
    );
  }
});
