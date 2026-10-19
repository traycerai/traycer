import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { artifactDocumentBundle } from "../artifact-document-bundle";

// The serializer writes a nested list and a fenced block at the parent item's
// content column. A parser that strips a different number of columns moves
// them on every pass, so a document drifts a little further with each save.

const MARKERS = ["1.", "10.", "100."];

function pad(marker: string): string {
  return " ".repeat(marker.length + 1);
}

function roundTrip(markdown: string): string {
  return jsonContentToMarkdown(
    artifactDocumentBundle.markdownManager.parse(markdown),
    { mentionFormat: "llm", platform: "POSIX" },
  );
}

function shapes(marker: string): ReadonlyArray<readonly [string, string]> {
  const p = pad(marker);
  // Only a list starting at 1 can interrupt a paragraph, so any other nested
  // ordered list sits behind a blank line under a line of text.
  const gap = marker === "1." ? "" : "\n";
  return [
    [
      "a fence under an ordered item",
      `${marker} a\n${p}\`\`\`\n${p}code\n${p}\`\`\``,
    ],
    [
      "a second paragraph and a fence in an ordered item",
      `${marker} First item\n\n${p}Second paragraph\n${p}\`\`\`js\n${p}x\n${p}\`\`\``,
    ],
    [
      "a fence-first ordered item",
      `${marker} \n${p}\`\`\`\n${p}code\n${p}\`\`\``,
    ],
    [
      "a task list under an ordered item",
      `${marker} a\n${p}- [ ] t\n${p}  \`\`\`\n${p}  code\n${p}  \`\`\``,
    ],
    [
      "an ordered list under a task item",
      `- [ ] t\n${gap}  ${marker} a\n  ${p}\`\`\`\n  ${p}code\n  ${p}\`\`\``,
    ],
    [
      "an ordered list under an ordered item",
      `${marker} one\n${gap}${p}${marker} nested\n${p}${p}\`\`\`\n${p}${p}x\n${p}${p}\`\`\``,
    ],
  ];
}

const FIXED_POINTS: ReadonlyArray<readonly [string, string]> = [
  ["a second paragraph in a task item", "- [ ] First\n\n  Second"],
  ["a paragraph after a nested list", "- a\n  - x\n\n  c"],
  ["a fence-first task item", "- [ ] \n  ```\n  code\n  ```"],
  ["an empty ordered item mid-list", "1. a\n2. \n3. c"],
  ["an empty last ordered item", "1. a\n2. "],
];

describe("artifact markdown list round trip", () => {
  for (const [name, markdown] of FIXED_POINTS) {
    it(`reaches a fixed point for ${name}`, () => {
      const first = roundTrip(markdown);
      expect(first).toBe(markdown);
      expect(roundTrip(first)).toBe(first);
    });
  }

  for (const marker of MARKERS) {
    for (const [name, markdown] of shapes(marker)) {
      it(`reaches a fixed point for ${name} at ${marker}`, () => {
        const first = roundTrip(markdown);
        expect(first).toBe(markdown);
        expect(roundTrip(first)).toBe(first);
      });
    }
  }
});

describe("artifact markdown paren-delimited ordered item", () => {
  it("keeps the second paragraph inside the item over two passes", () => {
    const first = roundTrip("1) First item\n\n   Second paragraph");
    expect(first).toBe("1. First item\n\n   Second paragraph");
    expect(roundTrip(first)).toBe(first);
  });
});

// A hard break in an item's first paragraph writes a bare newline. The
// serializer must put the next line at the item's content column, or the
// parser moves it out of the item into a top-level paragraph.

const SERIALIZER_OPTIONS = { mentionFormat: "llm", platform: "POSIX" } as const;

function hardBreakParagraph(first: string, second: string): JsonContent {
  return {
    type: "paragraph",
    content: [
      { type: "text", text: first },
      { type: "hardBreak" },
      { type: "text", text: second },
    ],
  };
}

function collectText(node: JsonContent): string[] {
  const own =
    node.type === "text" && node.text !== undefined ? [node.text] : [];
  return [...own, ...(node.content ?? []).flatMap(collectText)];
}

function listDoc(list: JsonContent): JsonContent {
  return { type: "doc", content: [list] };
}

const HARD_BREAK_CASES: ReadonlyArray<readonly [string, string, JsonContent]> =
  [
    [
      "a task item",
      "taskList",
      listDoc({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [hardBreakParagraph("First", "Second")],
          },
        ],
      }),
    ],
    [
      "a task item whose second line looks like a bullet",
      "taskList",
      listDoc({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [hardBreakParagraph("First", "- Second")],
          },
        ],
      }),
    ],
    [
      "a bullet item",
      "bulletList",
      listDoc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [hardBreakParagraph("First", "Second")],
          },
        ],
      }),
    ],
    ...[1, 10, 100].map((start): readonly [string, string, JsonContent] => [
      `an ordered item numbered ${String(start)}`,
      "orderedList",
      listDoc({
        type: "orderedList",
        attrs: { start },
        content: [
          {
            type: "listItem",
            content: [hardBreakParagraph("First", "Second")],
          },
        ],
      }),
    ]),
  ];

describe("artifact markdown list hard break in the first paragraph", () => {
  for (const [name, listType, source] of HARD_BREAK_CASES) {
    it(`keeps both lines inside ${name} and converges`, () => {
      const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
      const parsed = artifactDocumentBundle.markdownManager.parse(md1);

      const top = parsed.content ?? [];
      expect(top.map((node) => node.type)).toEqual([listType]);
      const items = top[0].content ?? [];
      expect(items).toHaveLength(1);
      const inside = collectText(items[0]).join("");
      expect(inside).toContain("First");
      expect(inside).toContain("Second");

      const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
      const md3 = jsonContentToMarkdown(
        artifactDocumentBundle.markdownManager.parse(md2),
        SERIALIZER_OPTIONS,
      );
      expect(md3).toBe(md2);
    });
  }
});

// An item whose first paragraph is empty writes its marker line with nothing on
// it. A blank line after that ends the item, so the next paragraph has to
// follow directly or it falls out of the list.

function emptyFirstParagraphItems(): JsonContent[] {
  return [
    { type: "paragraph" },
    { type: "paragraph", content: [{ type: "text", text: "b" }] },
  ];
}

const EMPTY_FIRST_PARAGRAPH_CASES: ReadonlyArray<
  readonly [string, string, JsonContent]
> = [
  [
    "a bullet item",
    "bulletList",
    listDoc({
      type: "bulletList",
      content: [{ type: "listItem", content: emptyFirstParagraphItems() }],
    }),
  ],
  [
    "a task item",
    "taskList",
    listDoc({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: emptyFirstParagraphItems(),
        },
      ],
    }),
  ],
  ...[1, 10, 100].map((start): readonly [string, string, JsonContent] => [
    `an ordered item numbered ${String(start)}`,
    "orderedList",
    listDoc({
      type: "orderedList",
      attrs: { start },
      content: [{ type: "listItem", content: emptyFirstParagraphItems() }],
    }),
  ]),
];

describe("artifact markdown list empty first paragraph before a paragraph", () => {
  for (const [name, listType, source] of EMPTY_FIRST_PARAGRAPH_CASES) {
    it(`keeps the paragraph inside ${name} and converges`, () => {
      const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
      const parsed = artifactDocumentBundle.markdownManager.parse(md1);

      const top = parsed.content ?? [];
      expect(top.map((node) => node.type)).toEqual([listType]);
      const items = top[0].content ?? [];
      expect(items).toHaveLength(1);
      expect(childTypes(items[0])).toEqual(["paragraph"]);
      expect(paragraphText((items[0].content ?? [])[0])).toBe("b");

      const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
      const md3 = jsonContentToMarkdown(
        artifactDocumentBundle.markdownManager.parse(md2),
        SERIALIZER_OPTIONS,
      );
      expect(md3).toBe(md2);
    });
  }
});

// Lines after an item's first line join that line's paragraph while they open
// no block of their own, whether they are indented or lazily at column zero.
// The soft break arrives as a newline inside the paragraph's text, so a
// paragraph's text is the concatenation of its text nodes.

function parseMarkdown(markdown: string): JsonContent {
  return artifactDocumentBundle.markdownManager.parse(markdown);
}

function childTypes(node: JsonContent): string[] {
  return (node.content ?? []).map((child) => child.type ?? "");
}

function onlyListItem(markdown: string, listType: string): JsonContent {
  const top = parseMarkdown(markdown).content ?? [];
  expect(top.map((node) => node.type)).toEqual([listType]);
  const items = top[0].content ?? [];
  expect(items).toHaveLength(1);
  return items[0];
}

function paragraphText(paragraph: JsonContent): string {
  return collectText(paragraph).join("");
}

function nestedInOnlyItem(markdown: string, listType: string): JsonContent {
  const parent = onlyListItem(markdown, listType);
  expect(childTypes(parent)).toEqual(["paragraph", "taskList"]);
  const nestedItems = parent.content?.[1].content ?? [];
  expect(nestedItems).toHaveLength(1);
  return nestedItems[0];
}

function expectJoinedParagraph(item: JsonContent): void {
  expect(childTypes(item)).toEqual(["paragraph"]);
  expect(paragraphText((item.content ?? [])[0])).toBe("First\nSecond");
}

describe("artifact markdown list continuation lines join the item's paragraph", () => {
  it("joins an indented continuation of a task item", () => {
    expectJoinedParagraph(onlyListItem("- [ ] First\n  Second", "taskList"));
  });

  it("joins a lazy column-zero continuation of a task item", () => {
    expectJoinedParagraph(onlyListItem("- [ ] First\nSecond", "taskList"));
  });

  it("joins the continuation of a task item nested under a bullet item", () => {
    expectJoinedParagraph(
      nestedInOnlyItem("- a\n  - [ ] First\n    Second", "bulletList"),
    );
  });

  for (const marker of MARKERS) {
    const p = pad(marker);

    it(`joins the continuation of a task item nested under an ordered item at ${marker}`, () => {
      expectJoinedParagraph(
        nestedInOnlyItem(
          `${marker} a\n${p}- [ ] First\n${p}  Second`,
          "orderedList",
        ),
      );
    });

    it(`keeps the indented continuation of an ordered item at ${marker} in one paragraph`, () => {
      expectJoinedParagraph(
        onlyListItem(`${marker} First\n${p}Second`, "orderedList"),
      );
    });
  }

  it("keeps the indented continuation of a bullet item in one paragraph", () => {
    expectJoinedParagraph(onlyListItem("- First\n  Second", "bulletList"));
  });

  const BLOCK_STARTS: ReadonlyArray<readonly [string, string, string]> = [
    ["a bullet list", "- [ ] First\n  - x", "bulletList"],
    ["an ordered list", "- [ ] First\n  1. x", "orderedList"],
    ["a fence", "- [ ] First\n  ```\n  code\n  ```", "codeBlock"],
    ["a blockquote", "- [ ] First\n  > q", "blockquote"],
  ];

  for (const [name, markdown, blockType] of BLOCK_STARTS) {
    it(`nests ${name} under the task item instead of joining it`, () => {
      const item = onlyListItem(markdown, "taskList");
      expect(childTypes(item)).toEqual(["paragraph", blockType]);
      expect(paragraphText((item.content ?? [])[0])).toBe("First");
    });
  }

  const FIXED_POINT_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ["a task item", "- [ ] First\n  Second"],
    ["a task item under a bullet item", "- a\n  - [ ] First\n    Second"],
    ...MARKERS.map((marker): readonly [string, string] => [
      `a task item under an ordered item at ${marker}`,
      `${marker} a\n${pad(marker)}- [ ] First\n${pad(marker)}  Second`,
    ]),
  ];

  for (const [name, markdown] of FIXED_POINT_SHAPES) {
    it(`writes ${name} back byte for byte over three passes`, () => {
      const pass1 = roundTrip(markdown);
      expect(pass1).toBe(markdown);
      const pass2 = roundTrip(pass1);
      expect(pass2).toBe(markdown);
      expect(roundTrip(pass2)).toBe(markdown);
    });
  }

  const EMPTY_FIRST_LINE: ReadonlyArray<
    readonly [string, string, string, string]
  > = [
    ["a task item", "taskList", "- [ ] \n  b", "- [ ] b"],
    ["a bullet item", "bulletList", "-\n  b", "- b"],
    ["an ordered item", "orderedList", "1. \n   b", "1. b"],
  ];

  for (const [name, listType, markdown, written] of EMPTY_FIRST_LINE) {
    it(`takes the continuation as the text of ${name} with an empty first line`, () => {
      const item = onlyListItem(markdown, listType);
      // The empty first line used to leave a bare text node in a bullet item,
      // which the editor schema rejects: the item holds one paragraph.
      expect(childTypes(item)).toEqual(["paragraph"]);
      expect(paragraphText((item.content ?? [])[0])).toBe("b");

      const pass1 = roundTrip(markdown);
      expect(pass1).toBe(written);
      const pass2 = roundTrip(pass1);
      expect(pass2).toBe(written);
      expect(roundTrip(pass2)).toBe(written);
    });
  }

  it("holds the continuation of a nested bullet item with an empty first line in one paragraph", () => {
    const parent = onlyListItem("- a\n  - x\n  -\n    b", "bulletList");
    expect(childTypes(parent)).toEqual(["paragraph", "bulletList"]);
    const nestedItems = parent.content?.[1].content ?? [];
    expect(nestedItems).toHaveLength(2);
    expect(childTypes(nestedItems[1])).toEqual(["paragraph"]);
    expect(paragraphText((nestedItems[1].content ?? [])[0])).toBe("b");
  });

  it("keeps a hard-broken task item in one paragraph and converges from the editor JSON", () => {
    const source = listDoc({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [hardBreakParagraph("First", "Second")],
        },
      ],
    });
    const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
    const parsed = parseMarkdown(md1);
    const item = (parsed.content ?? [])[0].content?.[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expectJoinedParagraph(item);

    const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
    const md3 = jsonContentToMarkdown(parseMarkdown(md2), SERIALIZER_OPTIONS);
    expect(md2).toBe(md1);
    expect(md3).toBe(md1);
  });
});

// A nested list whose first item is empty writes a bare `-` right under the
// parent's paragraph. Read directly under that line it is a setext heading
// underline, so the serializer puts a blank line before such a list.

function emptyText(): JsonContent {
  return { type: "paragraph" };
}

function textPara(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

const NESTED_EMPTY_ITEMS: ReadonlyArray<
  readonly [string, ReadonlyArray<JsonContent>, string | null]
> = [
  ["an empty nested item", [{ type: "listItem" }], null],
  [
    "an empty first paragraph before a paragraph in the nested item",
    [{ type: "listItem", content: [emptyText(), textPara("b")] }],
    "b",
  ],
];

function outerItem(
  outer: "bulletList" | "taskList" | "orderedList",
  start: number,
  nested: ReadonlyArray<JsonContent>,
): JsonContent {
  const inner: JsonContent = { type: "bulletList", content: [...nested] };
  const content = [textPara("a"), inner];
  if (outer === "taskList") {
    return listDoc({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: false }, content }],
    });
  }
  if (outer === "orderedList") {
    return listDoc({
      type: "orderedList",
      attrs: { start },
      content: [{ type: "listItem", content }],
    });
  }
  return listDoc({
    type: "bulletList",
    content: [{ type: "listItem", content }],
  });
}

const NESTED_PARENTS: ReadonlyArray<
  readonly [string, "bulletList" | "taskList" | "orderedList", number]
> = [
  ["a bullet item", "bulletList", 1],
  ["a task item", "taskList", 1],
  ["an ordered item at 1.", "orderedList", 1],
  ["an ordered item at 10.", "orderedList", 10],
];

describe("keeps an item's paragraph when a nested list opens with an empty bullet item", () => {
  for (const [parentName, outer, start] of NESTED_PARENTS) {
    for (const [nestedName, nested, nestedText] of NESTED_EMPTY_ITEMS) {
      it(`under ${parentName}: ${nestedName}`, () => {
        const md1 = jsonContentToMarkdown(
          outerItem(outer, start, nested),
          SERIALIZER_OPTIONS,
        );
        const parsed = parseMarkdown(md1);

        const top = parsed.content ?? [];
        expect(top.map((node) => node.type)).toEqual([outer]);
        const items = top[0].content ?? [];
        expect(items).toHaveLength(1);
        const children = items[0].content ?? [];
        expect(childTypes(items[0])).toEqual(["paragraph", "bulletList"]);
        expect(paragraphText(children[0])).toBe("a");
        if (nestedText !== null) {
          const nestedItem = (children[1].content ?? [])[0];
          expect(childTypes(nestedItem)).toEqual(["paragraph"]);
          expect(paragraphText((nestedItem.content ?? [])[0])).toBe(nestedText);
        }

        const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
        const md3 = jsonContentToMarkdown(
          parseMarkdown(md2),
          SERIALIZER_OPTIONS,
        );
        expect(md3).toBe(md2);
      });
    }
  }

  it("is not needed for a nested ordered list with an empty first item", () => {
    const parent = onlyListItem("- a\n  1. ", "bulletList");
    expect(childTypes(parent)).toEqual(["paragraph", "orderedList"]);
    expect(paragraphText((parent.content ?? [])[0])).toBe("a");
    const md2 = roundTrip("- a\n  1. ");
    expect(roundTrip(md2)).toBe(md2);
  });
});

// A task item's continuation line joins its first paragraph unless the nested
// parser would open a block there, measured from the item's content column. A
// line four columns past that column is indented code only while the first
// paragraph is empty: code cannot interrupt a paragraph.

interface TaskContext {
  readonly name: string;
  readonly parentLines: ReadonlyArray<string>;
  readonly taskIndent: string;
  readonly contentColumn: string;
}

const TASK_CONTEXTS: ReadonlyArray<TaskContext> = [
  {
    name: "a top-level task item",
    parentLines: [],
    taskIndent: "",
    contentColumn: "  ",
  },
  {
    name: "a bullet item",
    parentLines: ["- a"],
    taskIndent: "  ",
    contentColumn: "    ",
  },
  ...MARKERS.map((marker): TaskContext => ({
    name: `${marker}`,
    parentLines: [`${marker} a`],
    taskIndent: pad(marker),
    contentColumn: `${pad(marker)}  `,
  })),
];

type BlockKind =
  | "indentedCode"
  | "plain"
  | "block"
  | "joinedText"
  | "joinedInline"
  | "openTagAlone";

interface BlockLine {
  readonly name: string;
  readonly lines: ReadonlyArray<string>;
  readonly kind: BlockKind;
}

const BLOCK_LINES: ReadonlyArray<BlockLine> = [
  { name: "a bullet marker", lines: ["- x"], kind: "block" },
  { name: "an ordered marker", lines: ["1. x"], kind: "block" },
  { name: "a fence", lines: ["```", "code", "```"], kind: "block" },
  { name: "a blockquote", lines: ["> q"], kind: "block" },
  { name: "an ATX heading", lines: ["# h"], kind: "block" },
  { name: "a thematic break", lines: ["---"], kind: "block" },
  // `===` joins the paragraph as text: nested under a bullet parent it came
  // back as a bare text node when treated as an underline.
  { name: "a setext underline", lines: ["==="], kind: "joinedText" },
  { name: "an HTML block", lines: ["<div>hi</div>"], kind: "block" },
  // Only HTML block types 1-6 interrupt a paragraph. An autolink or an inline
  // tag line is never a block, and a lone open tag (type 7) opens one only
  // where no paragraph is open.
  {
    name: "an autolink",
    lines: ["<https://example.com>"],
    kind: "joinedInline",
  },
  { name: "an inline span", lines: ["<span>hi</span>"], kind: "joinedInline" },
  {
    name: "a mailto autolink",
    lines: ["<user@example.com>"],
    kind: "joinedInline",
  },
  { name: "an HTML comment", lines: ["<!-- c -->"], kind: "block" },
  { name: "a lone open tag", lines: ["<span>"], kind: "openTagAlone" },
  { name: "a table", lines: ["| a |", "| - |"], kind: "block" },
  {
    name: "a table without leading pipes",
    lines: ["A | B", "--- | ---"],
    kind: "block",
  },
  { name: "indented code", lines: ["    code"], kind: "indentedCode" },
  { name: "a plain line", lines: ["plain"], kind: "plain" },
];

const INLINE_NEEDLES: Record<string, string> = {
  "an autolink": "example.com",
  "a mailto autolink": "user@example.com",
  "an inline span": "hi",
};

function findTaskItem(parsed: JsonContent): JsonContent {
  const top = parsed.content ?? [];
  const first = top[0];
  expect(first).toBeDefined();
  if (first.type === "taskList") return (first.content ?? [])[0];
  const parentItem = (first.content ?? [])[0];
  const taskList = (parentItem.content ?? []).find(
    (child) => child.type === "taskList",
  );
  expect(taskList).toBeDefined();
  return ((taskList ?? first).content ?? [])[0];
}

function bulletChildren(
  lines: ReadonlyArray<string>,
  first: string,
): JsonContent[] {
  const markdown = [`- ${first}`, ...lines.map((line) => `  ${line}`)].join(
    "\n",
  );
  const list = (parseMarkdown(markdown).content ?? [])[0];
  return (list.content ?? [])[0].content ?? [];
}

function blockTitle(block: BlockLine, first: string): string {
  if (first === "") return block.name;
  if (block.name === "a thematic break") {
    return "a thematic break underlines it as a level-2 heading, as marked reads it";
  }
  if (block.name === "a setext underline") {
    return "a setext underline makes it a level-1 heading, as marked reads it";
  }
  if (block.name === "a lone open tag") {
    return "a lone open tag ends the paragraph and opens an HTML block, as marked reads it";
  }
  return block.name;
}

/**
 * The rows where marked ends a task item's non-empty first line with a block
 * of its own, as in a bullet item: a lone open tag opens an HTML block, which
 * the editor keeps as an empty paragraph, and `---` or `===` makes the first
 * line a setext heading. Returns whether the row was one of them.
 */
function expectMarkedBlockAfterFirstLine(
  block: BlockLine,
  first: string,
  item: JsonContent,
): boolean {
  if (first === "") return false;
  const children = item.content ?? [];
  if (block.kind === "openTagAlone") {
    expect(childTypes(item)).toEqual(["paragraph", "paragraph"]);
    expect(paragraphText(children[0])).toBe("first");
  } else if (
    block.name === "a thematic break" ||
    block.name === "a setext underline"
  ) {
    const level = block.name === "a thematic break" ? 2 : 1;
    expect(childTypes(item)).toEqual(["paragraph", "heading"]);
    expect(paragraphText(children[0])).toBe("");
    expect(children[1].attrs?.level).toBe(level);
    expect(paragraphText(children[1])).toBe(first);
  } else {
    return false;
  }
  expect(skeleton({ content: children })).toBe(
    skeleton({ content: bulletChildren(block.lines, first) }),
  );
  return true;
}

describe("a task item's continuation joins its paragraph only where no block opens", () => {
  for (const context of TASK_CONTEXTS) {
    for (const first of ["", "first"]) {
      for (const block of BLOCK_LINES) {
        const label = first === "" ? "empty" : "non-empty";
        it(`${label} first paragraph, ${blockTitle(block, first)}, under ${context.name}`, () => {
          const markdown = [
            ...context.parentLines,
            `${context.taskIndent}- [ ] ${first}`,
            ...block.lines.map((line) => `${context.contentColumn}${line}`),
          ].join("\n");
          const item = findTaskItem(parseMarkdown(markdown));
          const children = item.content ?? [];

          if (block.kind === "joinedInline") {
            const needle = INLINE_NEEDLES[block.name];
            expect(childTypes(item)).toEqual(["paragraph"]);
            expect(paragraphText(children[0])).toContain(needle);
            if (first !== "") {
              expect(paragraphText(children[0]).startsWith(`${first}\n`)).toBe(
                true,
              );
            }
            return;
          }

          if (expectMarkedBlockAfterFirstLine(block, first, item)) return;

          if (
            block.kind === "plain" ||
            block.kind === "joinedText" ||
            (block.kind === "indentedCode" && first !== "")
          ) {
            const joinedTextByKind: Record<string, string> = {
              plain: "plain",
              joinedText: "===",
              indentedCode: "code",
            };
            const text = joinedTextByKind[block.kind];
            expect(childTypes(item)).toEqual(["paragraph"]);
            expect(paragraphText(children[0])).toBe(
              first === "" ? text : `${first}\n${text}`,
            );
            return;
          }

          const reference = parseMarkdown(block.lines.join("\n")).content ?? [];
          expect(childTypes(item)[0]).toBe("paragraph");
          expect(paragraphText(children[0])).toBe(first);
          expect(children.slice(1)).toEqual(reference);
        });
      }
    }
  }
});

describe("a task item's setext heading text", () => {
  it("never holds the checkbox, unlike marked's own heading text", () => {
    for (const underline of ["---", "==="]) {
      const item = onlyListItem(`- [ ] first\n  ${underline}`, "taskList");
      expect(childTypes(item)).toEqual(["paragraph", "heading"]);
      expect(paragraphText((item.content ?? [])[1])).toBe("first");
    }
  });
});

describe("a task item's lazy continuation line", () => {
  const LAZY_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
    [
      "empty",
      "",
      "plain",
      "plain line at column 0 is a lazy continuation of the task item, as marked reads it",
    ],
    [
      "empty",
      " ",
      " plain",
      "plain line at column 1 is a lazy continuation that keeps its space, as marked reads it",
    ],
    [
      "non-empty",
      "",
      "first\nplain",
      "plain line at column 0 is a lazy continuation, as marked reads it",
    ],
    [
      "non-empty",
      " ",
      "first\n plain",
      "plain line at column 1 is a lazy continuation that keeps its space, as marked reads it",
    ],
  ];

  for (const [state, lead, expectedText, title] of LAZY_CASES) {
    it(`${state} first paragraph, ${title}`, () => {
      const first = state === "empty" ? "" : "first";
      const parsed = parseMarkdown(`- [ ] ${first}\n${lead}plain`);
      const top = parsed.content ?? [];
      expect(top.map((node) => node.type)).toEqual(["taskList"]);
      const item = (top[0].content ?? [])[0];
      expect(childTypes(item)).toEqual(["paragraph"]);
      expect(paragraphText((item.content ?? [])[0])).toBe(expectedText);
      if (state === "non-empty") {
        const bullet = (parseMarkdown(`- first\n${lead}plain`).content ??
          [])[0];
        const bulletItem = (bullet.content ?? [])[0];
        expect(paragraphText((bulletItem.content ?? [])[0])).toBe(expectedText);
      }
    });
  }
});

// A list that is an item's FIRST child: the item's marker line stays bare and
// the nested list starts on the next line at the item's content column.

function skeleton(node: JsonContent): string {
  const text = node.text === undefined ? "" : `:${node.text}`;
  const kids = (node.content ?? []).map(skeleton).join(",");
  return `${node.type ?? ""}${text}(${kids})`;
}

function listWith(
  type: "bulletList" | "orderedList",
  items: ReadonlyArray<JsonContent>,
  start: number,
): JsonContent {
  return type === "orderedList"
    ? { type, attrs: { start }, content: [...items] }
    : { type, content: [...items] };
}

function itemOf(...children: JsonContent[]): JsonContent {
  return { type: "listItem", content: children };
}

// The editor's schema makes every item start with a paragraph, so a list that
// is written first comes back behind an empty one.
function leadingEmpty(list: JsonContent): JsonContent {
  return itemOf({ type: "paragraph" }, list);
}

const LIST_FIRST_CHILD_CASES: ReadonlyArray<readonly [string, JsonContent]> = [
  [
    "a bullet list of two items inside a bullet item",
    listDoc(
      listWith(
        "bulletList",
        [
          leadingEmpty(
            listWith(
              "bulletList",
              [itemOf(textPara("x")), itemOf(textPara("y"))],
              1,
            ),
          ),
        ],
        1,
      ),
    ),
  ],
  [
    "three bullet lists deep",
    listDoc(
      listWith(
        "bulletList",
        [
          leadingEmpty(
            listWith(
              "bulletList",
              [
                leadingEmpty(
                  listWith("bulletList", [itemOf(textPara("x"))], 1),
                ),
              ],
              1,
            ),
          ),
        ],
        1,
      ),
    ),
  ],
  [
    "an ordered list inside an ordered item at 1.",
    listDoc(
      listWith(
        "orderedList",
        [
          leadingEmpty(
            listWith(
              "orderedList",
              [itemOf(textPara("x")), itemOf(textPara("y"))],
              1,
            ),
          ),
        ],
        1,
      ),
    ),
  ],
  [
    "a bullet list inside an ordered item at 10.",
    listDoc(
      listWith(
        "orderedList",
        [leadingEmpty(listWith("bulletList", [itemOf(textPara("x"))], 1))],
        10,
      ),
    ),
  ],
  [
    "an ordered list inside a bullet item",
    listDoc(
      listWith(
        "bulletList",
        [leadingEmpty(listWith("orderedList", [itemOf(textPara("x"))], 1))],
        1,
      ),
    ),
  ],
];

describe("a list as an item's first child", () => {
  for (const [name, source] of LIST_FIRST_CHILD_CASES) {
    it(`keeps its structure and converges: ${name}`, () => {
      const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
      const parsed = parseMarkdown(md1);
      expect(skeleton(parsed)).toBe(skeleton(source));

      const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
      const md3 = jsonContentToMarkdown(parseMarkdown(md2), SERIALIZER_OPTIONS);
      expect(md2).toBe(md1);
      expect(md3).toBe(md1);
    });
  }
});

// The ordered tokenizer used to pull a nested `1. x` out of the block it was
// written in and make it a sibling list of the outer ordered item. The
// structure that was serialized has to be the structure that comes back.

function expectStructureBack(source: JsonContent): void {
  const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
  const parsed = parseMarkdown(md1);
  expect(skeleton(parsed)).toBe(skeleton(source));

  const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
  const md3 = jsonContentToMarkdown(parseMarkdown(md2), SERIALIZER_OPTIONS);
  expect(md2).toBe(md1);
  expect(md3).toBe(md1);
}

function orderedAt(start: number, ...children: JsonContent[]): JsonContent {
  return listDoc(listWith("orderedList", [itemOf(...children)], start));
}

function orderedX(): JsonContent {
  return listWith("orderedList", [itemOf(textPara("x"))], 1);
}

describe("an ordered list nested in another block under an ordered item stays in that block", () => {
  for (const start of [1, 10, 100]) {
    it(`under a bullet list inside an ordered item at ${String(start)}.`, () => {
      expectStructureBack(
        orderedAt(
          start,
          textPara("a"),
          listWith("bulletList", [itemOf(textPara("b"), orderedX())], 1),
        ),
      );
    });

    it(`under a task list inside an ordered item at ${String(start)}.`, () => {
      expectStructureBack(
        orderedAt(start, textPara("a"), {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [textPara("t"), orderedX()],
            },
          ],
        }),
      );
    });

    it(`under a blockquote inside an ordered item at ${String(start)}.`, () => {
      const column = " ".repeat(String(start).length + 2);
      const markdown = `${String(start)}. a\n${column}> q\n${column}> 1. x`;
      const expected = orderedAt(start, textPara("a"), {
        type: "blockquote",
        content: [textPara("q"), orderedX()],
      });
      const parsed = parseMarkdown(markdown);
      expect(skeleton(parsed)).toBe(skeleton(expected));
      const md = roundTrip(markdown);
      expect(roundTrip(md)).toBe(md);
    });
  }

  it("keeps a `1. x` line inside a fence under an ordered item as code", () => {
    expectStructureBack(
      orderedAt(1, textPara("a"), {
        type: "codeBlock",
        content: [{ type: "text", text: "1. x\n2. y" }],
      }),
    );
  });

  it("keeps an ordered list under an empty task item under an ordered item", () => {
    const expected = orderedAt(1, textPara("a"), {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph" }, orderedX()],
        },
      ],
    });
    const markdown = "1. a\n   - [ ] \n     1. x";
    const parsed = parseMarkdown(markdown);
    expect(skeleton(parsed)).toBe(skeleton(expected));
    const md = roundTrip(markdown);
    expect(roundTrip(md)).toBe(md);
  });

  it("counts a tab as columns when a bullet list and an ordered list nest under an ordered item", () => {
    const expected = orderedAt(
      1,
      textPara("outer"),
      listWith("bulletList", [itemOf(textPara("b"), orderedX())], 1),
    );
    const parsed = parseMarkdown("1. outer\n\t- b\n\t\t1. x");
    expect(skeleton(parsed)).toBe(skeleton(expected));
  });

  it("counts a tab as columns when a task list and an ordered list nest under an ordered item", () => {
    const expected = orderedAt(1, textPara("outer"), {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [textPara("t"), orderedX()],
        },
      ],
    });
    const parsed = parseMarkdown("1. outer\n\t- [ ] t\n\t\t1. x");
    expect(skeleton(parsed)).toBe(skeleton(expected));
  });

  it("keeps a plain nested ordered list nested", () => {
    const expected = orderedAt(
      1,
      textPara("a"),
      listWith("orderedList", [itemOf(textPara("b"))], 1),
    );
    const parsed = parseMarkdown("1. a\n   1. b");
    expect(skeleton(parsed)).toBe(skeleton(expected));
    const md = roundTrip("1. a\n   1. b");
    expect(roundTrip(md)).toBe(md);
  });

  it("keeps an ordered list after a bullet list at the same column as a sibling inside the item", () => {
    const expected = orderedAt(
      1,
      textPara("a"),
      listWith("bulletList", [itemOf(textPara("b"))], 1),
      orderedX(),
    );
    const parsed = parseMarkdown("1. a\n   - b\n   1. x");
    expect(skeleton(parsed)).toBe(skeleton(expected));
    const md = roundTrip("1. a\n   - b\n   1. x");
    expect(roundTrip(md)).toBe(md);
  });
});

// The ordered list written after a deeper list must stay in its own
// container. Round trips converge after the first pass, so only the parsed
// structure can show a list that moved out.

describe("an ordered list after a deeper list stays in its container", () => {
  function bulletOf(...items: JsonContent[]): JsonContent {
    return listWith("bulletList", items, 1);
  }
  function orderedOf(...items: JsonContent[]): JsonContent {
    return listWith("orderedList", items, 1);
  }
  function taskOf(text: string): JsonContent {
    return {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [textPara(text)],
        },
      ],
    };
  }

  for (const start of [1, 10, 100]) {
    const at = `${String(start)}.`;

    it(`keeps x in b after a bullet list c, inside an ordered item at ${at}`, () => {
      expectStructureBack(
        orderedAt(
          start,
          textPara("a"),
          bulletOf(
            itemOf(
              textPara("b"),
              bulletOf(itemOf(textPara("c"))),
              orderedOf(itemOf(textPara("x"))),
            ),
          ),
        ),
      );
    });

    it(`keeps x in b after a task list c, inside an ordered item at ${at}`, () => {
      expectStructureBack(
        orderedAt(
          start,
          textPara("a"),
          bulletOf(
            itemOf(
              textPara("b"),
              taskOf("c"),
              orderedOf(itemOf(textPara("x"))),
            ),
          ),
        ),
      );
    });

    it(`keeps y in c and x in b two levels deep, inside an ordered item at ${at}`, () => {
      expectStructureBack(
        orderedAt(
          start,
          textPara("a"),
          bulletOf(
            itemOf(
              textPara("b"),
              bulletOf(
                itemOf(
                  textPara("c"),
                  bulletOf(itemOf(textPara("d"))),
                  orderedOf(itemOf(textPara("y"))),
                ),
              ),
              orderedOf(itemOf(textPara("x"))),
            ),
          ),
        ),
      );
    });

    it(`keeps x in b after a list and a tail paragraph, inside an ordered item at ${at}`, () => {
      expectStructureBack(
        orderedAt(
          start,
          textPara("a"),
          bulletOf(
            itemOf(
              textPara("b"),
              bulletOf(itemOf(textPara("c"))),
              textPara("tail"),
              orderedOf(itemOf(textPara("x"))),
            ),
          ),
        ),
      );
    });
  }
});

describe("keeps a continuation line's non-breaking spaces", () => {
  const NBSP = "\u00a0";

  function onlyTaskItemParagraph(markdown: string): JsonContent {
    const item = onlyListItem(markdown, "taskList");
    expect(childTypes(item)).toEqual(["paragraph"]);
    return (item.content ?? [])[0];
  }

  it("leaves the non-breaking spaces after the content column in the text", () => {
    const paragraph = onlyTaskItemParagraph(
      `- [ ] First\n  ${NBSP}${NBSP}indented`,
    );
    expect(paragraphText(paragraph)).toBe(`First\n${NBSP}${NBSP}indented`);
  });

  it("leaves a non-breaking space in the text of an item with an empty first line", () => {
    const paragraph = onlyTaskItemParagraph(`- [ ] \n  ${NBSP}x`);
    expect(paragraphText(paragraph)).toBe(`${NBSP}x`);
  });

  it("keeps the non-breaking spaces of a hard-broken task item through the parse and converges", () => {
    const source = listDoc({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [hardBreakParagraph("First", `${NBSP}${NBSP}x`)],
        },
      ],
    });
    const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
    const parsed = parseMarkdown(md1);
    const item = (parsed.content ?? [])[0].content?.[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(childTypes(item)).toEqual(["paragraph"]);
    expect(paragraphText((item.content ?? [])[0])).toBe(
      `First\n${NBSP}${NBSP}x`,
    );

    const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
    const md3 = jsonContentToMarkdown(parseMarkdown(md2), SERIALIZER_OPTIONS);
    expect(md2).toBe(md1);
    expect(md3).toBe(md1);
  });
});

// An HTML block opener under a task item keeps its body literal, whatever
// attribute grammar the opener uses. The list-looking line inside it belongs
// to the HTML block, and a quoted `<` or `>` in an attribute does not end it.

function hasNodeType(node: JsonContent, type: string): boolean {
  return (
    node.type === type || (node.content ?? []).some((c) => hasNodeType(c, type))
  );
}

function expectLiteralBody(item: JsonContent): void {
  expect(childTypes(item)).toEqual(["paragraph", "paragraph"]);
  expect(paragraphText((item.content ?? [])[0])).toBe("");
  // The editor drops an HTML tag from text, so only the list line is checked.
  const body = paragraphText((item.content ?? [])[1]);
  expect(body).toContain("- x");
  expect(hasNodeType(item, "bulletList")).toBe(false);
}

const HTML_OPENERS: ReadonlyArray<readonly [string, string]> = [
  ["double-quoted `>`", '<span title=">">'],
  ["double-quoted `<`", '<span title="<">'],
  ["single-quoted `>`", "<span title='>'>"],
  ["single-quoted `<`", "<span title='<'>"],
  ["unquoted", "<span title=x>"],
  ["multi-attribute", "<a href=x b=\"c>\" d='e<' data-f>"],
  ["self-closing", '<custom-el a="1>"/>'],
  ["closing tag alone", "</span>"],
];

describe("an HTML block opener under an empty task paragraph", () => {
  it("keeps a quoted `>` attribute, a list line and the closing tag in one paragraph", () => {
    const item = onlyListItem(
      '- [ ] \n  <span title=">">\n  - x\n  </span>',
      "taskList",
    );
    expectLiteralBody(item);
  });
});

describe("an HTML block opener with any attribute grammar keeps its body literal under an empty task paragraph", () => {
  for (const [name, opener] of HTML_OPENERS) {
    it(name, () => {
      const item = onlyListItem(`- [ ] \n  ${opener}\n  - x`, "taskList");
      expectLiteralBody(item);
    });
  }
});

describe("an HTML block opener after a non-empty task paragraph", () => {
  for (const [name, opener] of HTML_OPENERS) {
    it(`ends the paragraph and keeps the list line in the HTML block, as a bullet item does: ${name}`, () => {
      const task = onlyListItem(`- [ ] first\n  ${opener}\n  - x`, "taskList");
      const bullet = onlyListItem(`- first\n  ${opener}\n  - x`, "bulletList");
      expect(childTypes(task)).toEqual(["paragraph", "paragraph"]);
      expect(paragraphText((task.content ?? [])[0])).toBe("first");
      expect(paragraphText((task.content ?? [])[1])).toContain("- x");
      expect(hasNodeType(task, "bulletList")).toBe(false);
      expect(skeleton(task)).toBe(
        skeleton(bullet).replace("listItem", "taskItem"),
      );
    });
  }
});

describe("a continuation line follows marked's block rules under a task item", () => {
  it("opens an ordered list at `2. x`, as marked reads a bullet item", () => {
    const item = onlyListItem("- [ ] first\n  2. x", "taskList");
    const bullet = onlyListItem("- first\n  2. x", "bulletList");
    expect(childTypes(item)).toEqual(["paragraph", "orderedList"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("first");
    expect((item.content ?? [])[1].attrs?.start).toBe(2);
    expect(skeleton(item)).toBe(
      skeleton(bullet).replace("listItem", "taskItem"),
    );
  });

  it("opens an ordered list at `1. x`", () => {
    const item = onlyListItem("- [ ] first\n  1. x", "taskList");
    expect(childTypes(item)).toEqual(["paragraph", "orderedList"]);
  });

  it("reads a lazy `===` at column zero as a level-1 setext underline, as marked does", () => {
    const item = onlyListItem("- [ ] first\n===", "taskList");
    const bullet = onlyListItem("- first\n===", "bulletList");
    expect(childTypes(item)).toEqual(["paragraph", "heading"]);
    expect((item.content ?? [])[1].attrs?.level).toBe(1);
    expect(paragraphText((item.content ?? [])[1])).toBe("first");
    expect(skeleton(item)).toBe(
      skeleton(bullet).replace("listItem", "taskItem"),
    );
  });

  it("ends the item at a lazy `---` at column zero", () => {
    const top = parseMarkdown("- [ ] first\n---").content ?? [];
    expect(top.map((node) => node.type)).toEqual([
      "taskList",
      "horizontalRule",
    ]);
  });

  it("reads an indented `===` as a level-1 setext underline, as marked does", () => {
    const item = onlyListItem("- [ ] first\n  ===", "taskList");
    const bullet = onlyListItem("- first\n  ===", "bulletList");
    expect(childTypes(item)).toEqual(["paragraph", "heading"]);
    expect((item.content ?? [])[1].attrs?.level).toBe(1);
    expect(skeleton(item)).toBe(
      skeleton(bullet).replace("listItem", "taskItem"),
    );
  });

  it("reads an indented `---` as a level-2 setext underline, as marked does", () => {
    const item = onlyListItem("- [ ] first\n  ---", "taskList");
    const bullet = onlyListItem("- first\n  ---", "bulletList");
    expect(childTypes(item)).toEqual(["paragraph", "heading"]);
    expect((item.content ?? [])[1].attrs?.level).toBe(2);
    expect(paragraphText((item.content ?? [])[1])).toBe("first");
    expect(skeleton(item)).toBe(
      skeleton(bullet).replace("listItem", "taskItem"),
    );
  });
});

describe("an ordered list after a paragraph survives the serializer in every item kind", () => {
  const CHILDREN: ReadonlyArray<readonly [string, JsonContent]> = [
    [
      "an ordered list starting at 10",
      listWith("orderedList", [itemOf(textPara("x"))], 10),
    ],
  ];

  function container(kind: string, content: JsonContent[]): JsonContent {
    if (kind === "a task item") {
      return listDoc({
        type: "taskList",
        content: [{ type: "taskItem", attrs: { checked: false }, content }],
      });
    }
    if (kind === "an ordered item") {
      return orderedAt(1, ...content);
    }
    return listDoc(listWith("bulletList", [itemOf(...content)], 1));
  }

  for (const kind of ["a task item", "a bullet item", "an ordered item"]) {
    for (const [name, child] of CHILDREN) {
      it(`keeps ${name} after a paragraph in ${kind}`, () => {
        const source = container(kind, [textPara("first"), child]);
        const md = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
        expect(skeleton(parseMarkdown(md))).toBe(skeleton(source));
      });
    }
  }
});

// ---- A. what a task item does with each continuation line
//
// A task item's nested content is lexed in top mode, where a list, a type-7
// tag or indented code interrupts text, so it legitimately differs from a
// bullet item. The outcomes below are written out row by row.

interface ContinuationRow {
  readonly name: string;
  readonly markdown: string;
  readonly check: (children: ReadonlyArray<JsonContent>) => void;
}

function textOfNode(node: JsonContent): string {
  return collectText(node).join("");
}

function onlyParagraph(text: string): (c: ReadonlyArray<JsonContent>) => void {
  return (children) => {
    expect(children.map((c) => c.type)).toEqual(["paragraph"]);
    expect(textOfNode(children[0])).toBe(text);
  };
}

function paragraphThen(
  second: string,
  secondText: string,
): (c: ReadonlyArray<JsonContent>) => void {
  return (children) => {
    expect(children.map((c) => c.type)).toEqual(["paragraph", second]);
    expect(textOfNode(children[0])).toBe("First");
    expect(textOfNode(children[1])).toBe(secondText);
  };
}

function firstThenParagraph(children: ReadonlyArray<JsonContent>): void {
  expect(children.map((c) => c.type)).toEqual(["paragraph", "paragraph"]);
  expect(textOfNode(children[0])).toBe("First");
}

const CONTINUATION_ROWS: ReadonlyArray<ContinuationRow> = [
  {
    name: "a quoted-attribute tag ends the paragraph and keeps the list line in its HTML block",
    markdown: '- [ ] First\n  <span title=">">\n  - x',
    check: (children) => {
      expect(children.map((c) => c.type)).toEqual(["paragraph", "paragraph"]);
      expect(textOfNode(children[0])).toBe("First");
      expect(textOfNode(children[1])).toContain("- x");
    },
  },
  {
    name: "an autolink",
    markdown: "- [ ] First\n  <https://example.com>",
    check: onlyParagraph("First\nhttps://example.com"),
  },
  {
    name: "an inline span",
    markdown: "- [ ] First\n  <span>hi</span>",
    check: (children) => {
      expect(children.map((c) => c.type)).toEqual(["paragraph"]);
    },
  },
  {
    name: "a div",
    markdown: "- [ ] First\n  <div>hi</div>",
    check: firstThenParagraph,
  },
  {
    name: "an HTML comment",
    markdown: "- [ ] First\n  <!-- c -->",
    check: firstThenParagraph,
  },
  {
    name: "`2. x` opens an ordered list starting at 2, as marked reads a bullet item",
    markdown: "- [ ] First\n  2. x",
    check: paragraphThen("orderedList", "x"),
  },
  {
    name: "`1. x`",
    markdown: "- [ ] First\n  1. x",
    check: (children) => {
      expect(children.map((c) => c.type)).toEqual(["paragraph", "orderedList"]);
      expect(textOfNode(children[1])).toBe("x");
    },
  },
  {
    name: "a heading",
    markdown: "- [ ] First\n  # h",
    check: paragraphThen("heading", "h"),
  },
  {
    name: "a fence",
    markdown: "- [ ] First\n  ```\n  code\n  ```",
    check: paragraphThen("codeBlock", "code"),
  },
  {
    name: "a table without leading pipes",
    markdown: "- [ ] First\n  header | value\n  - | -",
    check: (children) => {
      expect(children[0].type).toBe("paragraph");
      expect(textOfNode(children[0])).toBe("First");
      expect(textOfNode(children[0])).not.toContain("header");
    },
  },
  {
    name: "a plain line",
    markdown: "- [ ] First\n  plain",
    check: onlyParagraph("First\nplain"),
  },
  {
    name: "a link definition",
    markdown: "- [ ] First\n  [a]: /u",
    check: onlyParagraph("First\n[a]: /u"),
  },
  {
    name: "two spaces past the content column",
    markdown: "- [ ] First\n    more",
    check: onlyParagraph("First\n  more"),
  },
  {
    name: "four spaces past the content column",
    markdown: "- [ ] First\n      code",
    check: onlyParagraph("First\ncode"),
  },
  {
    name: "a tab",
    markdown: "- [ ] First\n\tx",
    check: onlyParagraph("First\n  x"),
  },
  {
    name: "indented code under an empty paragraph",
    markdown: "- [ ] \n      code",
    check: (children) => {
      expect(children.map((c) => c.type)).toEqual(["paragraph", "codeBlock"]);
      expect(textOfNode(children[0])).toBe("");
      expect(textOfNode(children[1])).toBe("code");
    },
  },
];

describe("a task item reads each continuation line as its own rules say", () => {
  for (const row of CONTINUATION_ROWS) {
    it(row.name, () => {
      const item = onlyListItem(row.markdown, "taskList");
      row.check(item.content ?? []);
    });
  }
});

// ---- B. continuation spaces
//
// Raw markdown rows. The escaped form of a hard-broken line is covered by the
// artifact serializer's own matrix, so no JSON row is needed here.

describe("a continuation line keeps the spaces past the content column", () => {
  const SPACE_ROWS: ReadonlyArray<readonly [string, string, string]> = [
    ["two spaces past the content column", "    more", "First\n  more"],
    ["an escaped dash after five spaces", "     \\- x", "First\n   - x"],
    ["four spaces past the content column", "      code", "First\ncode"],
    ["a tab", "\tx", "First\n  x"],
  ];

  for (const box of ["[ ]", "[x]"]) {
    for (const [name, line, expected] of SPACE_ROWS) {
      it(`${box === "[x]" ? "checked: " : ""}${name}`, () => {
        const item = onlyListItem(`- ${box} First\n${line}`, "taskList");
        expect(childTypes(item)).toEqual(["paragraph"]);
        expect(paragraphText((item.content ?? [])[0])).toBe(expected);
      });
    }
  }
});

// ---- C. the artifact schema keeps a list that is an item's first child

function isJsonContentValue(value: unknown): value is JsonContent {
  return typeof value === "object" && value !== null && "type" in value;
}

function throughSchema(parsed: JsonContent): JsonContent {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("artifact-body");
  prosemirrorJSONToYXmlFragment(
    artifactDocumentBundle.schema,
    parsed,
    fragment,
  );
  const root = yXmlFragmentToProseMirrorRootNode(
    fragment,
    artifactDocumentBundle.schema,
  );
  const json: unknown = root.toJSON();
  if (!isJsonContentValue(json)) throw new Error("not a node");
  return json;
}

describe("a list as an item's first child survives the artifact schema", () => {
  function sItem(withBreak: boolean): JsonContent {
    return {
      type: "listItem",
      content: [withBreak ? hardBreakParagraph("s", "t") : textPara("s")],
    };
  }

  function sourceFor(kind: string, withBreak: boolean): JsonContent {
    const nested: JsonContent = {
      type: "bulletList",
      content: [sItem(withBreak)],
    };
    const content = [{ type: "paragraph" }, nested];
    if (kind === "task" || kind === "checked task") {
      return listDoc({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: kind === "checked task" },
            content,
          },
        ],
      });
    }
    if (kind.startsWith("ordered")) {
      return orderedAt(Number(kind.slice(8)), ...content);
    }
    return listDoc({
      type: "bulletList",
      content: [{ type: "listItem", content }],
    });
  }

  for (const kind of [
    "bullet",
    "ordered 1",
    "ordered 10",
    "ordered 100",
    "task",
    "checked task",
  ]) {
    for (const withBreak of [false, true]) {
      it(`${kind}${withBreak ? " with a hard break in s" : ""}`, () => {
        const md = jsonContentToMarkdown(
          sourceFor(kind, withBreak),
          SERIALIZER_OPTIONS,
        );
        const loaded = throughSchema(parseMarkdown(md));
        const item = ((loaded.content ?? [])[0].content ?? [])[0];
        expect(item).toBeDefined();
        expect(childTypes(item)).toEqual(["paragraph", "bulletList"]);
      });
    }
  }
});

// ---- D. the ordered-list scanner

describe("the ordered list scanner follows marked's list rules", () => {
  function orderedItems(markdown: string): JsonContent[] {
    const top = parseMarkdown(markdown).content ?? [];
    expect(top.map((node) => node.type)).toEqual(["orderedList"]);
    return top[0].content ?? [];
  }

  for (const marker of ["1.", "10.", "100."]) {
    const next = `${String(Number.parseInt(marker, 10) + 1)}.`;
    const p = " ".repeat(marker.length + 1);

    it(`keeps item ${next} c a sibling after a nested bullet list, at ${marker}`, () => {
      const items = orderedItems(`${marker} a\n${p}- b\n${next} c`);
      expect(items).toHaveLength(2);
      expect(childTypes(items[0])).toEqual(["paragraph", "bulletList"]);
      expect(paragraphText((items[0].content ?? [])[0])).toBe("a");
      expect(childTypes(items[1])).toEqual(["paragraph"]);
      expect(paragraphText((items[1].content ?? [])[0])).toBe("c");
    });

    it(`closes an unterminated fence at the next item, at ${marker}`, () => {
      const items = orderedItems(`${marker} a\n${p}\`\`\`\n${next} b`);
      expect(items).toHaveLength(2);
      expect(childTypes(items[0])).toEqual(["paragraph", "codeBlock"]);
      expect(childTypes(items[1])).toEqual(["paragraph"]);
      expect(paragraphText((items[1].content ?? [])[0])).toBe("b");
    });
  }

  it("does not open a fence on a backtick info string that contains a backtick", () => {
    const items = orderedItems("1. a\n   ```js`bad\n2. b");
    expect(items).toHaveLength(2);
    expect(hasNodeType(items[0], "codeBlock")).toBe(false);
    expect(paragraphText((items[1].content ?? [])[0])).toBe("b");
  });

  it("closes a fence on a closer that continues with other fence characters", () => {
    const top =
      parseMarkdown("1. a\n   ```\n   x\n   ```~~~\n   2. b").content ?? [];
    const item = (top[0].content ?? [])[0];
    const codeTexts: string[] = [];
    const collectCode = (node: JsonContent): void => {
      if (node.type === "codeBlock") codeTexts.push(collectText(node).join(""));
      (node.content ?? []).forEach(collectCode);
    };
    collectCode(item);
    expect(codeTexts).toEqual(["x"]);
    const paragraphs: string[] = [];
    const collectParagraphs = (node: JsonContent): void => {
      if (node.type === "paragraph") paragraphs.push(paragraphText(node));
      (node.content ?? []).forEach(collectParagraphs);
    };
    collectParagraphs(item);
    expect(paragraphs.some((text) => text.includes("b"))).toBe(true);
  });
});

describe("an ordered list starting above 1 directly under an empty first paragraph", () => {
  function tenList(): JsonContent {
    return listWith("orderedList", [itemOf(textPara("a"))], 10);
  }

  it("stays in a bullet item", () => {
    expectStructureBack(
      listDoc(
        listWith("bulletList", [itemOf({ type: "paragraph" }, tenList())], 1),
      ),
    );
  });

  it("stays in an ordered item", () => {
    expectStructureBack(orderedAt(1, { type: "paragraph" }, tenList()));
  });

  it("stays in a task item", () => {
    expectStructureBack(
      listDoc({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph" }, tenList()],
          },
        ],
      }),
    );
  });
});

// ---- F. a horizontal rule survives the serializer in every position

describe("a horizontal rule survives the serializer in every position", () => {
  const rule: JsonContent = { type: "horizontalRule" };
  const empty: JsonContent = { type: "paragraph" };
  const a = textPara("a");
  const b = textPara("b");
  const x = listWith("bulletList", [itemOf(textPara("x"))], 1);

  function topDoc(...content: JsonContent[]): JsonContent {
    return { type: "doc", content };
  }

  function taskDoc(...items: JsonContent[][]): JsonContent {
    return listDoc({
      type: "taskList",
      content: items.map((content) => ({
        type: "taskItem",
        attrs: { checked: false },
        content,
      })),
    });
  }

  function itemsDoc(
    type: "bulletList" | "orderedList",
    start: number,
    ...items: JsonContent[][]
  ): JsonContent {
    return listDoc(
      listWith(
        type,
        items.map((children) => itemOf(...children)),
        start,
      ),
    );
  }

  const ROWS: ReadonlyArray<readonly [string, JsonContent, string]> = [
    ["a lone rule", topDoc(rule), "---"],
    ["a rule before a paragraph", topDoc(rule, a), "---\n\na"],
    ["a rule between paragraphs", topDoc(a, rule, b), "a\n\n---\n\nb"],
    ["a rule after a paragraph", topDoc(a, rule), "a\n\n---"],
    [
      "a rule after a heading",
      topDoc(
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "H" }],
        },
        rule,
      ),
      "## H\n\n---",
    ],
    [
      "two rules between paragraphs",
      topDoc(a, rule, rule, b),
      "a\n\n---\n\n---\n\nb",
    ],
    [
      "a rule after text in a bullet item",
      itemsDoc("bulletList", 1, [a, rule]),
      "- a\n\n  ---",
    ],
    [
      "a rule behind an empty paragraph in a bullet item",
      itemsDoc("bulletList", 1, [empty, rule]),
      "-\n  ---",
    ],
    [
      "a rule after a nested list in a bullet item",
      itemsDoc("bulletList", 1, [a, x, rule]),
      "- a\n  - x\n\n  ---",
    ],
    [
      "two rules after text in a bullet item",
      itemsDoc("bulletList", 1, [a, rule, rule]),
      "- a\n\n  ---\n\n  ---",
    ],
    [
      "a rule between paragraphs in a bullet item",
      itemsDoc("bulletList", 1, [a, rule, b]),
      "- a\n\n  ---\n\n  b",
    ],
    [
      "a rule after text in an ordered item at 1",
      itemsDoc("orderedList", 1, [a, rule]),
      "1. a\n\n   ---",
    ],
    [
      "a rule after text in an ordered item at 10",
      itemsDoc("orderedList", 10, [a, rule]),
      "10. a\n\n    ---",
    ],
    [
      "a rule behind an empty paragraph in an ordered item at 100",
      itemsDoc("orderedList", 100, [empty, rule]),
      "100. \n     ---",
    ],
    [
      "a rule after a nested list in an ordered item with a sibling",
      itemsDoc("orderedList", 1, [a, x, rule], [b]),
      "1. a\n   - x\n\n   ---\n2. b",
    ],
    [
      "a rule after text in a task item",
      taskDoc([a, rule]),
      "- [ ] a\n\n  ---",
    ],
    [
      "a rule behind an empty paragraph in a task item",
      taskDoc([empty, rule]),
      "- [ ] \n  ---",
    ],
    [
      "a rule after a nested list in a task item",
      taskDoc([a, x, rule]),
      "- [ ] a\n  - x\n\n  ---",
    ],
    [
      "two rules in a task item with a sibling",
      taskDoc([a, rule, rule], [b]),
      "- [ ] a\n\n  ---\n\n  ---\n- [ ] b",
    ],
    [
      "a rule in a nested bullet item",
      itemsDoc("bulletList", 1, [
        a,
        listWith("bulletList", [itemOf(b, rule)], 1),
      ]),
      "- a\n  - b\n\n    ---",
    ],
  ];

  for (const [name, source, bytes] of ROWS) {
    it(`keeps ${name}`, () => {
      expect(jsonContentToMarkdown(source, SERIALIZER_OPTIONS)).toBe(bytes);
      expectStructureBack(source);
    });

    it(`keeps ${name} through the artifact schema`, () => {
      const parsed = parseMarkdown(
        jsonContentToMarkdown(source, SERIALIZER_OPTIONS),
      );
      expect(skeleton(throughSchema(parsed))).toBe(skeleton(source));
    });
  }

  it("writes a bullet item holding only a rule as an empty marker and the rule", () => {
    const source = itemsDoc("bulletList", 1, [rule]);
    const md = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
    expect(md).toBe("-\n  ---");
    expect(md).not.toBe("- ---");
    const parsed = parseMarkdown(md);
    expect(skeleton(parsed)).toBe(
      skeleton(itemsDoc("bulletList", 1, [empty, rule])),
    );
    expect(skeleton(throughSchema(parsed))).toBe(skeleton(parsed));
    expect(jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS)).toBe(md);
  });
});

// ---- G. a continuation probe must not register what it looked at

function linkHrefs(node: JsonContent): string[] {
  const own = (node.marks ?? [])
    .filter((mark) => mark.type === "link")
    .map((mark) => {
      const href = mark.attrs?.href;
      return typeof href === "string" ? href : "";
    });
  return [...own, ...(node.content ?? []).flatMap(linkHrefs)];
}

function lastTopParagraph(parsed: JsonContent): JsonContent {
  const top = parsed.content ?? [];
  const last = top[top.length - 1];
  expect(last).toBeDefined();
  expect(last.type).toBe("paragraph");
  return last;
}

describe("a continuation probe leaves no reference definition behind", () => {
  it("keeps a later [x] plain after a task item whose first line looks like a definition", () => {
    const parsed = parseMarkdown("- [ ] [x]: /wrong\n  continuation\n\n[x]");
    const item = findTaskItem(parsed);
    expect(childTypes(item)).toEqual(["paragraph"]);
    const text = paragraphText((item.content ?? [])[0]);
    expect(text).toContain("[x]: /wrong");
    expect(text).toContain("continuation");
    const last = lastTopParagraph(parsed);
    expect(paragraphText(last)).toBe("[x]");
    expect(linkHrefs(last)).toEqual([]);
  });

  it("keeps a [x] in a following task item plain", () => {
    const parsed = parseMarkdown(
      "- [ ] [x]: /wrong\n  continuation\n- [ ] [x]",
    );
    const list = (parsed.content ?? [])[0];
    expect(list.type).toBe("taskList");
    const items = list.content ?? [];
    expect(items).toHaveLength(2);
    expect(paragraphText((items[1].content ?? [])[0])).toBe("[x]");
    expect(linkHrefs(items[1])).toEqual([]);
    expect(linkHrefs(parsed)).toEqual([]);
  });

  it("still reads a definition at the start of a bullet item's content as a definition", () => {
    const parsed = parseMarkdown("- [x]: /wrong\n  continuation\n\n[x]");
    expect(linkHrefs(lastTopParagraph(parsed))).toEqual(["/wrong"]);
    const item = onlyListItem("- [x]: /wrong\n  continuation", "bulletList");
    expect(collectText(item).join("")).toContain("continuation");
  });

  it("reads a definition at the start of an ordered item's content as a definition, as a bullet item does", () => {
    const parsed = parseMarkdown("1. [x]: /wrong\n   continuation\n\n[x]");
    const top = parsed.content ?? [];
    expect(top.map((node) => node.type)).toEqual(["orderedList", "paragraph"]);
    expect(linkHrefs(lastTopParagraph(parsed))).toEqual(["/wrong"]);
    const bullet = parseMarkdown("- [x]: /wrong\n  continuation\n\n[x]");
    expect(linkHrefs(bullet)).toEqual(linkHrefs(parsed));
    const orderedItem = (top[0].content ?? [])[0];
    expect(childTypes(orderedItem)).toEqual(["paragraph"]);
    expect(paragraphText((orderedItem.content ?? [])[0])).toBe("continuation");
  });

  it("still defines a top-level definition for a later [x]", () => {
    const parsed = parseMarkdown("[x]: /right\n\n- [ ] a\n  b\n\n[x]");
    expect(linkHrefs(lastTopParagraph(parsed))).toEqual(["/right"]);
  });

  it("still defines a definition nested in a task item for a later [x]", () => {
    const parsed = parseMarkdown("- [ ] a\n\n  [x]: /right\n\n[x]");
    expect(linkHrefs(lastTopParagraph(parsed))).toEqual(["/right"]);
  });

  it("reads a definition under an empty task paragraph as a real definition", () => {
    const parsed = parseMarkdown("- [ ] \n  [x]: /def\n\n[x]");
    expect(linkHrefs(lastTopParagraph(parsed))).toEqual(["/def"]);
  });
});

// ---- H. the ordered content column is measured from one to four spaces

describe("an ordered item's content column follows the spaces after its marker", () => {
  it("keeps a fence indented from a three-space gap inside the item", () => {
    const parsed = parseMarkdown(
      "1.   a\n        ```\n        2. x\n        ```\n2. b",
    );
    const top = parsed.content ?? [];
    expect(top.map((node) => node.type)).toEqual(["orderedList"]);
    const items = top[0].content ?? [];
    expect(items).toHaveLength(2);
    expect(childTypes(items[0])).toEqual(["paragraph", "codeBlock"]);
    expect(paragraphText((items[0].content ?? [])[0])).toBe("a");
    expect(collectText((items[0].content ?? [])[1]).join("")).toBe("2. x");
    expect(childTypes(items[1])).toEqual(["paragraph"]);
    expect(paragraphText((items[1].content ?? [])[0])).toBe("b");
  });

  it("joins a continuation indented to a two-space gap", () => {
    const item = onlyListItem("1.  a\n    b", "orderedList");
    expect(childTypes(item)).toEqual(["paragraph"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("a\nb");
  });
});

// ---- H2. a fence indented up to three spaces keeps its code
//
// CommonMark lets a fence sit up to three spaces in, and marked reads it so;
// the code block parser used to drop any fence that did not start at column
// zero, so the code vanished.

describe("a fence indented up to three spaces keeps its code", () => {
  const ROWS: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> =
    [
      ["at the top level", "   ```\n   code\n   ```", ["codeBlock"]],
      ["one space in", " ```\n code\n ```", ["codeBlock"]],
      [
        "under a bullet item",
        "- a\n\n     ```\n     code\n     ```",
        ["bulletList"],
      ],
      [
        "under a task item",
        "- [ ] a\n\n     ```\n     code\n     ```",
        ["taskList"],
      ],
      [
        "under an ordered item",
        "1. a\n\n      ```\n      code\n      ```",
        ["orderedList"],
      ],
    ];
  for (const [name, markdown, topTypes] of ROWS) {
    it(`keeps the code ${name}`, () => {
      const parsed = parseMarkdown(markdown);
      expect(childTypes(parsed)).toEqual(topTypes);
      expect(hasNodeType(parsed, "codeBlock")).toBe(true);
      expect(collectText(parsed).join("")).toContain("code");
      expect(collectText(parsed).join("")).not.toContain("```");
    });
  }

  it("keeps an ordered list's tab-indented task list and its nested list", () => {
    const parsed = parseMarkdown("1. outer\n\t- [ ] t\n\t\t1. x");
    expect(collectText(parsed).join("|")).toBe("outer|t|x");
  });
});

// ---- I. a table cell's blocks stay in the table

describe("a table cell holding a task list comes back as one table", () => {
  it("parses the cell's <br>-joined lines into a two-row, one-cell table", () => {
    const source: JsonContent = {
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
                  content: [textPara("h")],
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
                      type: "taskList",
                      content: [
                        {
                          type: "taskItem",
                          attrs: { checked: false },
                          content: [textPara("a")],
                        },
                        {
                          type: "taskItem",
                          attrs: { checked: true },
                          content: [textPara("b")],
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
    const md = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
    expect(md.split("\n")).toHaveLength(3);
    const parsed = parseMarkdown(md);
    const top = parsed.content ?? [];
    expect(top.map((node) => node.type)).toEqual(["table"]);
    const rows = top[0].content ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.content ?? []).toHaveLength(1);
    }
    expect(hasNodeType(parsed, "taskList")).toBe(false);
  });
});

// ---- J. a marker that is only text stays text

// Only the list serializer's own empty marker lines keep their space. Text
// that looks like a marker is trimmed like any other line; reading it back as
// a paragraph needs the artifact serializer's line-start escaping (#2584),
// since `1.` alone is an empty ordered item to marked.
describe("a paragraph that reads like an empty marker keeps no marker space", () => {
  it("trims '1. ' to '1.'", () => {
    const md = jsonContentToMarkdown(
      { type: "doc", content: [textPara("1. ")] },
      SERIALIZER_OPTIONS,
    );
    expect(md).toBe("1.");
  });
});

// ---- K. an empty nested item keeps its list under every bullet marker

describe("an empty nested bullet item under text comes back as a nested list", () => {
  for (const bulletMarker of ["-", "*", "+"] as const) {
    it(`keeps the nested list written with ${bulletMarker}`, () => {
      const source = listDoc(
        listWith(
          "bulletList",
          [
            itemOf(
              textPara("parent"),
              listWith("bulletList", [itemOf({ type: "paragraph" })], 1),
            ),
          ],
          1,
        ),
      );
      const md = jsonContentToMarkdown(source, {
        ...SERIALIZER_OPTIONS,
        bulletMarker,
      });
      expect(md).toBe(`${bulletMarker} parent\n\n  ${bulletMarker}`);
      const parsed = parseMarkdown(md);
      expect(skeleton(parsed)).toBe(skeleton(source));
    });
  }
});

// ---- L. the serializer's own markers never read as the user's text

describe("a U+FDD0 the user typed comes back byte-identical", () => {
  const FDD0 = "\uFDD0";

  it("keeps the character in a paragraph, a bullet item and a table cell beside an empty item", () => {
    const source: JsonContent = {
      type: "doc",
      content: [
        textPara(`x${FDD0}y`),
        listWith("bulletList", [itemOf(textPara(FDD0))], 1),
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader", content: [textPara("h")] }],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [textPara(`a${FDD0}b`)] },
              ],
            },
          ],
        },
        listWith("orderedList", [itemOf({ type: "paragraph" })], 1),
      ],
    };
    const md = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
    expect(md.split(FDD0)).toHaveLength(4);
    expect(md.endsWith("\n1. ")).toBe(true);
    const texts = collectText(parseMarkdown(md));
    expect(texts).toContain(`x${FDD0}y`);
    expect(texts).toContain(FDD0);
    expect(texts).toContain(`a${FDD0}b`);
  });

  it("keeps a paragraph that is exactly '1.' and the character", () => {
    const md = jsonContentToMarkdown(
      { type: "doc", content: [textPara(`1.${FDD0}`)] },
      SERIALIZER_OPTIONS,
    );
    expect(md).toBe(`1.${FDD0}`);
    expect(collectText(parseMarkdown(md)).join("")).toBe(`1.${FDD0}`);
  });
});

describe("a <br> typed in a table cell comes back as that text", () => {
  for (const typed of ["a<br>b", "a<BR/>b"]) {
    it(`keeps ${typed} as literal text with no hard break`, () => {
      const source: JsonContent = {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [{ type: "tableHeader", content: [textPara("h")] }],
              },
              {
                type: "tableRow",
                content: [{ type: "tableCell", content: [textPara(typed)] }],
              },
            ],
          },
        ],
      };
      const md = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
      const parsed = parseMarkdown(md);
      expect(hasNodeType(parsed, "hardBreak")).toBe(false);
      expect(collectText(parsed).join("")).toContain(typed);
    });
  }
});

// ---- M. an ordered item that opens with a block lexes it as marked does

function itemsOf(markdown: string, listType: string): JsonContent[] {
  const top = parseMarkdown(markdown).content ?? [];
  expect(top.map((node) => node.type)).toContain(listType);
  const list = top.find((node) => node.type === listType);
  expect(list).toBeDefined();
  return (list ?? top[0]).content ?? [];
}

function firstItemOf(markdown: string, listType: string): JsonContent {
  return itemsOf(markdown, listType)[0];
}

function firstListOf(markdown: string): JsonContent {
  return (parseMarkdown(markdown).content ?? [])[0];
}

// `lines` hold the item's first line (after the marker's one-space gap) and
// its continuation lines relative to the content column.
function orderedSource(marker: string, lines: ReadonlyArray<string>): string {
  const pad = " ".repeat(marker.length + 1);
  return lines
    .map((line, index) => (index === 0 ? `${marker} ${line}` : `${pad}${line}`))
    .join("\n");
}

function bulletSource(lines: ReadonlyArray<string>): string {
  return lines
    .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
    .join("\n");
}

const OPENING_BLOCKS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> =
  [
    ["a heading", ["# h"]],
    ["a quote", ["> q"]],
    ["a fenced code block", ["```js", "code", "```"]],
    ["indented code", ["     a"]],
    ["an HTML block", ["<div>", " x", " </div>"]],
    ["a nested bullet list", ["- x"]],
  ];

describe("an ordered item that opens with a block lexes it as marked does", () => {
  for (const [name, lines] of OPENING_BLOCKS) {
    for (const [marker, start] of [
      ["1.", 1],
      ["10.", 10],
      ["100.", 100],
    ] as const) {
      it(`reads ${name} at ${marker} like a bullet item`, () => {
        const ordered = firstListOf(orderedSource(marker, lines));
        expect(ordered.type).toBe("orderedList");
        expect(ordered.attrs?.start ?? 1).toBe(start);
        const bullet = firstListOf(bulletSource(lines));
        expect(bullet.type).toBe("bulletList");
        expect(JSON.stringify((ordered.content ?? [])[0].content)).toBe(
          JSON.stringify((bullet.content ?? [])[0].content),
        );
      });
    }
  }

  for (const [marker, start] of [
    ["1.", 1],
    ["10.", 10],
    ["100.", 100],
  ] as const) {
    it(`reads a thematic break at ${marker} as an empty paragraph and a rule`, () => {
      const list = firstListOf(orderedSource(marker, ["---"]));
      expect(list.type).toBe("orderedList");
      expect(list.attrs?.start ?? 1).toBe(start);
      const item = (list.content ?? [])[0];
      expect(childTypes(item)).toEqual(["paragraph", "horizontalRule"]);
      expect(paragraphText((item.content ?? [])[0])).toBe("");
    });
  }

  it("reads `1. # h` as an empty paragraph and a heading", () => {
    const item = firstItemOf("1. # h", "orderedList");
    expect(childTypes(item)).toEqual(["paragraph", "heading"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("");
    expect(collectText((item.content ?? [])[1]).join("")).toBe("h");
  });

  it("reads six spaces after the marker as indented code", () => {
    const item = firstItemOf("1.      a", "orderedList");
    expect(childTypes(item)).toEqual(["paragraph", "codeBlock"]);
    expect(collectText((item.content ?? [])[1]).join("")).toBe(" a");
  });

  it("reads `1. 2. x` as a nested ordered list starting at 2", () => {
    const item = firstItemOf("1. 2. x", "orderedList");
    expect(childTypes(item)).toEqual(["paragraph", "orderedList"]);
    const nested = (item.content ?? [])[1];
    expect(nested.attrs?.start).toBe(2);
    expect(childTypes((nested.content ?? [])[0])).toEqual(["paragraph"]);
    expect(collectText(nested).join("")).toBe("x");
  });
});

describe("marked decides where an ordered item's paragraph ends", () => {
  function bulletForm(lines: ReadonlyArray<string>): string {
    return lines
      .map((line, index) =>
        index === 0 ? `- ${line.slice(3)}` : `  ${line.slice(3)}`,
      )
      .join("\n");
  }

  function expectParity(lines: ReadonlyArray<string>): JsonContent {
    const ordered = firstItemOf(lines.join("\n"), "orderedList");
    const bullet = firstItemOf(bulletForm(lines), "bulletList");
    expect(JSON.stringify(ordered.content)).toBe(
      JSON.stringify(bullet.content),
    );
    return ordered;
  }

  it("keeps a deeply indented fence line as paragraph text before a sibling sub-list", () => {
    const item = expectParity(["1. a", "       ```", "   2. b"]);
    expect(childTypes(item)).toEqual(["paragraph", "orderedList"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("a\n```");
    expect((item.content ?? [])[1].attrs?.start).toBe(2);
    expect(hasNodeType(item, "codeBlock")).toBe(false);
  });

  it("keeps a deeply indented fence and the line after it as paragraph text", () => {
    const item = expectParity(["1. a", "       ```", "       x", "   2. b"]);
    expect(childTypes(item)).toEqual(["paragraph", "orderedList"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("a\n```\nx");
    expect((item.content ?? [])[1].attrs?.start).toBe(2);
  });

  it("reads a rule under text as a setext heading", () => {
    const item = expectParity(["1. a", "   ---"]);
    expect(childTypes(item)).toEqual(["paragraph", "heading"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("");
    expect(collectText((item.content ?? [])[1]).join("")).toBe("a");
  });

  it("ends the paragraph after a heading opener", () => {
    const item = firstItemOf("1. # h\n   text", "orderedList");
    expect(childTypes(item)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(collectText((item.content ?? [])[1]).join("")).toBe("h");
    expect(paragraphText((item.content ?? [])[2])).toBe("text");
  });

  it("keeps a list-looking line inside a fence opened on the first line", () => {
    const item = expectParity(["1. ```", "   2. x", "   ```"]);
    expect(hasNodeType(item, "orderedList")).toBe(false);
    expect(hasNodeType(item, "codeBlock")).toBe(true);
    expect(collectText(item).join("")).toBe("2. x");
  });
});

describe("a continuation probe leaves no prototype-named definition behind", () => {
  const LABELS = ["constructor", "__proto__", "toString", "hasOwnProperty"];

  for (const label of LABELS) {
    it(`keeps a later [${label}] plain after a task item`, () => {
      const parsed = parseMarkdown(
        `- [ ] [${label}]: /wrong\n  continuation\n\n[${label}]`,
      );
      expect(linkHrefs(parsed)).toEqual([]);
      const item = findTaskItem(parsed);
      expect(childTypes(item)).toEqual(["paragraph"]);
    });

    for (const [name, build] of [
      ["bullet", (l: string) => `- [${l}]: /wrong\n  continuation\n\n[${l}]`],
      [
        "ordered",
        (l: string) => `1. [${l}]: /wrong\n   continuation\n\n[${l}]`,
      ],
    ] as const) {
      it(`reads a [${label}] definition in a ${name} item as it reads [x]`, () => {
        const withLabel = parseMarkdown(build(label));
        const withX = parseMarkdown(build("x"));
        expect(childTypes(withLabel)).toEqual(childTypes(withX));
        expect(linkHrefs(withLabel)).toEqual(linkHrefs(withX));
        expect(linkHrefs(withLabel)).toEqual(["/wrong"]);
      });
    }

    it(`keeps the real [${label}] definition ahead of a probed one`, () => {
      const parsed = parseMarkdown(
        `[${label}]: /right\n\n- [ ] [${label}]: /wrong\n  continuation\n\n[${label}]`,
      );
      expect(linkHrefs(lastTopParagraph(parsed))).toEqual(["/right"]);
    });
  }
});

// ---- N. the kept-marker placeholder never reads as the user's text

describe("a doc with runs of U+FDD0 survives alongside empty list items", () => {
  const FDD0 = "\uFDD0";

  function runsDoc(): JsonContent {
    return {
      type: "doc",
      content: [
        textPara(`x${FDD0.repeat(3)}y`),
        listWith("bulletList", [itemOf(textPara(`p${FDD0}q`))], 1),
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader", content: [textPara("h")] }],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [textPara(`a${FDD0}b`)] },
              ],
            },
          ],
        },
        listWith("orderedList", [itemOf({ type: "paragraph" })], 1),
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph" }],
            },
          ],
        },
      ],
    };
  }

  it("keeps the user's runs as typed and the empty items' trailing space", () => {
    const md = jsonContentToMarkdown(runsDoc(), SERIALIZER_OPTIONS);
    expect(md.split(FDD0)).toHaveLength(6);
    expect(md).toContain(`x${FDD0.repeat(3)}y`);
    expect(md).toContain(`- p${FDD0}q`);
    expect(md).toContain(`| a${FDD0}b |`);
    expect(md.split("\n")).toContain("1. ");
    expect(md.endsWith("\n- [ ] ")).toBe(true);
  });

  it("returns the same JSON after a markdown round trip", () => {
    expectStructureBack(runsDoc());
    const md = jsonContentToMarkdown(runsDoc(), SERIALIZER_OPTIONS);
    const texts = collectText(parseMarkdown(md));
    expect(texts).toContain(`x${FDD0.repeat(3)}y`);
    expect(texts).toContain(`p${FDD0}q`);
    expect(texts).toContain(`a${FDD0}b`);
  });
});

// ---- O. Unicode whitespace is text, as in a bullet item

describe("Unicode whitespace in a list item is text, as in a bullet item", () => {
  const NBSP = "\u00a0";
  const MARKER_ROWS = [
    ["1.", 1],
    ["10.", 10],
    ["100.", 100],
  ] as const;
  const SPACES: ReadonlyArray<readonly [string, string]> = [
    ["a non-breaking space", NBSP],
    ["an em space", "\u2003"],
    ["an ideographic space", "\u3000"],
    ["five spaces", "     "],
    ["a tab", "\t"],
  ];

  function itemContent(markdown: string, listType: string): string {
    return JSON.stringify(firstItemOf(markdown, listType).content);
  }

  for (const [marker] of MARKER_ROWS) {
    for (const [name, lead] of SPACES) {
      it(`reads ${name} before a continuation line under ${marker} as a bullet item does`, () => {
        const lines = ["a", `${lead}b`];
        expect(itemContent(orderedSource(marker, lines), "orderedList")).toBe(
          itemContent(bulletSource(lines), "bulletList"),
        );
      });
    }
  }

  it("reads a tab before a continuation line as a joined line in both forms", () => {
    for (const markdown of [
      orderedSource("1.", ["a", "\tb"]),
      bulletSource(["a", "\tb"]),
    ]) {
      const listType = markdown.startsWith("-") ? "bulletList" : "orderedList";
      const item = firstItemOf(markdown, listType);
      expect(paragraphText((item.content ?? [])[0])).toBe("a\nb");
    }
  });

  for (const [name, lead] of SPACES.slice(0, 3)) {
    it(`reads ${name} before a continuation line of a task item as a bullet item does`, () => {
      const task = firstItemOf(`- [ ] a\n  ${lead}b`, "taskList");
      const bullet = firstItemOf(`- a\n  ${lead}b`, "bulletList");
      expect(childTypes(task)).toEqual(["paragraph"]);
      expect(paragraphText((task.content ?? [])[0])).toBe(
        paragraphText((bullet.content ?? [])[0]),
      );
    });
  }

  it("keeps a non-breaking space after the marker's separator", () => {
    const item = firstItemOf(`1. ${NBSP}a`, "orderedList");
    expect(paragraphText((item.content ?? [])[0])).toBe(`${NBSP}a`);
  });

  it("keeps a leading space on a lazy continuation line", () => {
    const item = firstItemOf(`1. a\n${NBSP}b`, "orderedList");
    expect(paragraphText((item.content ?? [])[0])).toBe(`a\n${NBSP}b`);
  });

  it("keeps a trailing non-breaking space on a continuation line", () => {
    const item = firstItemOf(`1. a\n   b${NBSP}`, "orderedList");
    expect(paragraphText((item.content ?? [])[0])).toBe(`a\nb${NBSP}`);
  });

  it("reads a non-breaking-space marker separator as paragraph text, not a list", () => {
    for (const text of [`1.${NBSP}x`, `${NBSP}${NBSP}1. x`]) {
      const top = parseMarkdown(text).content ?? [];
      expect(top.map((node) => node.type)).toEqual(["paragraph"]);
      expect(paragraphText(top[0])).toBe(text);
    }
  });

  it("keeps a non-breaking space after a task marker", () => {
    const item = firstItemOf(`- [ ] ${NBSP}a`, "taskList");
    expect(paragraphText((item.content ?? [])[0])).toBe(`${NBSP}a`);
  });

  it("does not read a non-breaking-space-only line as blank", () => {
    const lines = ["a", NBSP, "b"];
    expect(itemContent(orderedSource("1.", lines), "orderedList")).toBe(
      itemContent(bulletSource(lines), "bulletList"),
    );
  });
});

// ---- P. a continuation line keeps the indent marked keeps

describe("a continuation line keeps the indent marked keeps", () => {
  function textOfFirstItem(markdown: string, listType: string): string {
    const item = firstItemOf(markdown, listType);
    return JSON.stringify(item.content);
  }

  for (let extra = 1; extra <= 9; extra++) {
    it(`reads ${extra} extra spaces under an ordered item as under a bullet item`, () => {
      expect(
        textOfFirstItem(`1. a\n${" ".repeat(3 + extra)}b`, "orderedList"),
      ).toBe(textOfFirstItem(`- a\n${" ".repeat(2 + extra)}b`, "bulletList"));
    });
  }

  for (let extra = 1; extra <= 6; extra++) {
    it(`reads ${extra} extra spaces under a task item as under a bullet item`, () => {
      const task = firstItemOf(
        `- [ ] a\n${" ".repeat(2 + extra)}b`,
        "taskList",
      );
      const bullet = firstItemOf(
        `- a\n${" ".repeat(2 + extra)}b`,
        "bulletList",
      );
      expect(childTypes(task)).toEqual(childTypes(bullet));
      expect(paragraphText((task.content ?? [])[0])).toBe(
        paragraphText((bullet.content ?? [])[0]),
      );
    });
  }

  it("keeps two spaces of an empty task item's continuation line", () => {
    const item = firstItemOf("- [ ] \n    more", "taskList");
    expect(childTypes(item)).toEqual(["paragraph"]);
    expect(paragraphText((item.content ?? [])[0])).toBe("  more");
  });

  it("keeps one space of an empty task item's continuation line", () => {
    const item = firstItemOf("- [ ] \n   more", "taskList");
    expect(childTypes(item)).toEqual(["paragraph"]);
    expect(paragraphText((item.content ?? [])[0])).toBe(" more");
  });

  function brokenParagraph(): JsonContent {
    return {
      type: "paragraph",
      content: [
        { type: "text", text: "a" },
        { type: "hardBreak" },
        { type: "text", text: "  b" },
      ],
    };
  }

  function expectIndentedBreakBack(source: JsonContent): void {
    const md1 = jsonContentToMarkdown(source, SERIALIZER_OPTIONS);
    const parsed = parseMarkdown(md1);
    expect(collectText(parsed).join("")).toBe("a\n  b");
    const md2 = jsonContentToMarkdown(parsed, SERIALIZER_OPTIONS);
    const md3 = jsonContentToMarkdown(parseMarkdown(md2), SERIALIZER_OPTIONS);
    expect(md2).toBe(md1);
    expect(md3).toBe(md1);
  }

  it("round-trips a hard break before indented text in an ordered item", () => {
    expectIndentedBreakBack(orderedAt(1, brokenParagraph()));
  });

  it("round-trips a hard break before indented text in a bullet item", () => {
    expectIndentedBreakBack(
      listDoc(listWith("bulletList", [itemOf(brokenParagraph())], 1)),
    );
  });

  it("round-trips a hard break before indented text in a task item", () => {
    expectIndentedBreakBack(
      listDoc({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [brokenParagraph()],
          },
        ],
      }),
    );
  });
});
