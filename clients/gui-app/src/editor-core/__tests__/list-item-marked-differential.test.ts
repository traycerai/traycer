import { createEvent } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { Lexer } from "marked";
import { afterAll, describe, expect, it } from "vitest";
import { artifactDocumentBundle } from "../artifact-document-bundle";

// Ordered and task items are read by a port of marked's list tokenizer, so a
// list item must read here the way marked reads it. This compares the first
// item's children and the item count against marked over generated corpora.
// A divergence is allowed only where one of the documented deviations below
// names it, and each class has a pinned count: a new divergence and a
// vanished one both fail.

function parseMarkdown(markdown: string): JsonContent {
  return artifactDocumentBundle.markdownManager.parse(markdown);
}

// ---- our side

type Shape =
  | readonly ["p", string]
  | readonly ["code", string]
  | readonly ["list", ReadonlyArray<ReadonlyArray<Shape>>]
  | readonly [string];

function textOf(node: JsonContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(textOf).join("");
}

function oursShape(item: JsonContent): Shape[] {
  const out: Shape[] = [];
  for (const child of item.content ?? []) {
    if (child.type === "paragraph") out.push(["p", textOf(child)]);
    else if (child.type === "codeBlock") out.push(["code", textOf(child)]);
    else if (child.type !== undefined && child.type.endsWith("List")) {
      out.push(["list", (child.content ?? []).map(oursShape)]);
    } else out.push([child.type ?? ""]);
  }
  const first = out[0];
  if (out.length > 1 && first[0] === "p" && first[1] === "") out.shift();
  return out;
}

type Reading = readonly [number, ReadonlyArray<ReadonlyArray<Shape>>];
type Outcome = Reading | readonly ["not-list"];

function oursReading(markdown: string, all: boolean): Outcome {
  const list = (parseMarkdown(markdown).content ?? []).at(0);
  if (list === undefined || !(list.type ?? "").endsWith("List")) {
    return ["not-list"];
  }
  const items = list.content ?? [];
  return [items.length, all ? items.map(oursShape) : [oursShape(items[0])]];
}

// ---- marked's side

interface MarkedToken {
  readonly type: string;
  readonly text?: string;
  readonly tokens?: ReadonlyArray<MarkedToken>;
  readonly items?: ReadonlyArray<MarkedToken>;
  readonly task?: boolean;
  readonly raw?: string;
  readonly loose?: boolean;
}

function isMarkedToken(value: unknown): value is MarkedToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function lex(markdown: string): MarkedToken[] {
  const tokens: unknown[] = new Lexer({ gfm: true }).lex(markdown);
  return tokens.filter(isMarkedToken);
}

function flat(tokens: ReadonlyArray<MarkedToken> | undefined): string {
  return (tokens ?? [])
    .map((token) => {
      if (token.type === "br") return "\n";
      if (token.tokens !== undefined && token.tokens.length > 0) {
        return flat(token.tokens);
      }
      return token.text ?? "";
    })
    .join("");
}

function theirsShape(tokens: ReadonlyArray<MarkedToken>): Shape[] {
  const out: Shape[] = [];
  for (const token of tokens) {
    if (token.type === "paragraph" || token.type === "text") {
      out.push([
        "p",
        token.tokens !== undefined ? flat(token.tokens) : (token.text ?? ""),
      ]);
    } else if (token.type === "code") out.push(["code", token.text ?? ""]);
    else if (token.type === "list") {
      out.push([
        "list",
        (token.items ?? []).map((item) => theirsShape(item.tokens ?? [])),
      ]);
    } else if (token.type === "space" || token.type === "checkbox") continue;
    else out.push([token.type]);
  }
  return out;
}

function theirsReading(markdown: string, all: boolean): Outcome {
  const first = lex(markdown).at(0);
  if (first === undefined || first.type !== "list") return ["not-list"];
  const items = first.items ?? [];
  return [
    items.length,
    all
      ? items.map((item) => theirsShape(item.tokens ?? []))
      : [theirsShape(items[0].tokens ?? [])],
  ];
}

// ---- corpus generation

function prefixes(): string[] {
  const out: string[] = [];
  function gen(prefix: string, column: number): void {
    out.push(prefix);
    if (prefix.length >= 8) return;
    for (const [char, next] of [
      [" ", column + 1],
      ["\t", column + 4 - (column % 4)],
    ] as const) {
      if (next <= 8) gen(prefix + char, next);
    }
  }
  gen("", 0);
  return out;
}

const PREFIXES = prefixes();
const MARKERS = ["-", "1.", "10.", "100.", "- [ ]"];
const GAPS = [" ", "  ", "   ", "    ", "     ", "\t"];
const UNIS = ["", "\u00a0", "\u2003", "\u3000"];
const UNI_ONLY = /^[ \t]*[\u00a0\u2003\u3000]+[ \t]*$/;

const KINDS: ReadonlyArray<readonly [string, (p: string) => string]> = [
  ["text", (p) => `${p}b`],
  ["empty", (p) => `${p}\n${p}b`],
  ["nested", (p) => `${p}- x`],
  ["fence", (p) => `${p}\`\`\`\n${p}c\n${p}\`\`\``],
];

function isOrdered(marker: string): boolean {
  return /^\d/.test(marker);
}

interface Mismatch {
  readonly source: string;
  readonly marker: string;
  readonly ours: Outcome;
  readonly theirs: Outcome;
}

// ---- deviations

const D1 = "D1 unicode-whitespace-only line is text";
const D2 = "D2 ordered legacy band at marker indent + 2";
const D3 = "D3 task list holds only task items";
const MIXED_D1_COUNT = 36;
const CORPUS_SIZE = 7395;

function classes(mismatch: Mismatch): string[] {
  const lines = mismatch.source.split("\n");
  const found: string[] = [];
  if (
    mismatch.marker !== "-" &&
    lines.slice(1).some((line) => UNI_ONLY.test(line))
  ) {
    found.push(D1);
  }
  if (
    isOrdered(mismatch.marker) &&
    lines
      .slice(1)
      .some((line) => /^ {2}(?! )(?:[-*+]|\d{1,9}[.)]|```)/.test(line))
  ) {
    found.push(D2);
  }
  if (
    mismatch.marker === "- [ ]" &&
    mismatch.ours[0] !== "not-list" &&
    mismatch.theirs[0] !== "not-list" &&
    mismatch.ours[0] < mismatch.theirs[0] &&
    lines.slice(1).some((line) => /^ ?- /.test(line))
  ) {
    found.push(D3);
  }
  return found;
}

function summarize(mismatches: ReadonlyArray<Mismatch>): {
  readonly counts: Record<string, number>;
  readonly unclassified: string[];
} {
  const counts: Record<string, number> = {};
  const unclassified: string[] = [];
  for (const mismatch of mismatches) {
    const found = classes(mismatch);
    if (found.length !== 1) {
      unclassified.push(
        `${JSON.stringify(mismatch.source)} -> ${found.join("+") || "none"}`,
      );
      continue;
    }
    const name = found[0];
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return { counts, unclassified };
}

function compare(
  source: string,
  marker: string,
  all: boolean,
  into: Mismatch[],
): void {
  const ours = oursReading(source, all);
  const theirs = theirsReading(source, all);
  if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
    into.push({ source, marker, ours, theirs });
  }
}

describe("a list item reads as marked reads it", () => {
  it("matches marked over marker, gap, continuation prefix, Unicode space and second line", () => {
    const corpus = MARKERS.flatMap((marker) =>
      GAPS.flatMap((gap) =>
        PREFIXES.flatMap((prefix) =>
          UNIS.flatMap((uni) =>
            KINDS.map(([, build]) => ({
              marker,
              source: `${marker}${gap}a\n${build(prefix + uni)}`,
            })),
          ),
        ),
      ),
    );
    const mismatches: Mismatch[] = [];
    for (const { marker, source } of corpus) {
      compare(source, marker, false, mismatches);
    }
    const { counts, unclassified } = summarize(mismatches);
    expect(unclassified).toEqual([]);
    expect(corpus.length).toBe(23520);
    expect(counts).toEqual({
      [D1]: 240,
      [D2]: 36,
      [D3]: 12,
    });
  });

  it("matches marked over content tabs and second items", () => {
    const corpus = MARKERS.flatMap((marker) => {
      const next = marker === "- [ ]" ? "- [x]" : marker;
      return GAPS.flatMap((gap) =>
        PREFIXES.flatMap((prefix) =>
          ["b\tc", `${next}${gap}b`, `${next}${gap}b\n${prefix}c`].map(
            (second) => ({
              marker,
              source: `${marker}${gap}a\tz\n${prefix}${second}`,
            }),
          ),
        ),
      );
    });
    const mismatches: Mismatch[] = [];
    for (const { marker, source } of corpus) {
      compare(source, marker, true, mismatches);
    }
    const { counts, unclassified } = summarize(mismatches);
    expect(unclassified).toEqual([]);
    expect(corpus.length).toBe(4410);
    expect(counts).toEqual({ [D2]: 36 });
  });
});

// ---- a task item inside a list that opens with a plain bullet

function mixedOurs(source: string): readonly [boolean | "none", Shape[]] {
  const doc = parseMarkdown(source).content ?? [];
  const tasks = doc.find((node) => node.type === "taskList");
  if (tasks !== undefined) return [true, oursShape((tasks.content ?? [])[0])];
  const bullets = doc.find((node) => node.type === "bulletList");
  const second = (bullets?.content ?? []).at(1);
  return second === undefined ? ["none", []] : [false, oursShape(second)];
}

function mixedTheirs(source: string): readonly [boolean | "none", Shape[]] {
  const list = lex(source).at(0);
  const item = (list?.items ?? []).at(1);
  if (item === undefined) return ["none", []];
  const shape = theirsShape(item.tokens ?? []);
  return [item.task === true, shape];
}

function mixedTaskSources(): string[] {
  const sources: string[] = [];
  for (const gap of GAPS) {
    for (const prefix of PREFIXES) {
      for (const uni of UNIS) {
        for (const [, build] of KINDS) {
          sources.push(`- [ ]${gap}a\n${build(prefix + uni)}`);
        }
      }
    }
  }
  return sources;
}

// What the first task item of a document reads as, wherever its list begins.
function standaloneOurs(source: string): readonly [boolean | "none", Shape[]] {
  const list = (parseMarkdown(source).content ?? [])[0];
  const item = (list.content ?? [])[0];
  return [list.type === "taskList", oursShape(item)];
}

describe("a task item in a list that opens with a bullet reads as marked reads it", () => {
  it("reads a mixed list's task item as the same item on its own, over gap, prefix, Unicode space and second line", () => {
    const mismatches: string[] = [];
    const markedMismatches: Mismatch[] = [];
    const tasks = mixedTaskSources();
    const total = tasks.length;
    for (const task of tasks) {
      const source = `- x\n${task}`;
      const mixed = mixedOurs(source);
      const marked = mixedTheirs(source);
      if (JSON.stringify(mixed) !== JSON.stringify(standaloneOurs(task))) {
        mismatches.push(JSON.stringify(source));
      }
      if (JSON.stringify(mixed) !== JSON.stringify(marked)) {
        markedMismatches.push({
          source,
          marker: "- [ ]",
          ours: [1, [mixed[1]]],
          theirs: [1, [marked[1]]],
        });
      }
    }
    expect(total).toBe(4704);
    expect(mismatches).toEqual([]);
    const { counts, unclassified } = summarize(markedMismatches);
    expect(unclassified).toEqual([]);
    expect(counts).toEqual({ [D1]: MIXED_D1_COUNT });
  });

  function taskItemIn(source: string): JsonContent {
    const doc = parseMarkdown(source).content ?? [];
    const tasks = doc.find((node) => node.type === "taskList");
    expect(tasks).toBeDefined();
    return ((tasks ?? doc[0]).content ?? [])[0];
  }

  it("reads a loose mixed list's task item without its checkbox text", () => {
    const item = taskItemIn("- x\n\n- [ ] a\n\n  more");
    expect((item.content ?? []).map((child) => child.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(textOf((item.content ?? [])[0])).toBe("a");
    expect(textOf((item.content ?? [])[1])).toBe("more");
    expect(textOf(item)).not.toContain("[ ]");
  });

  it("reads a setext underline under a mixed task item as a heading with no checkbox text", () => {
    const item = taskItemIn("- x\n- [ ] first\n  ---");
    const heading = (item.content ?? []).find(
      (child) => child.type === "heading",
    );
    expect(heading?.attrs?.level).toBe(2);
    expect(textOf(heading ?? item)).toBe("first");
    expect(textOf(item)).not.toContain("[ ]");
  });
});

describe("a checkbox needs text after it, as marked requires", () => {
  it("reads `- [ ]  a` as a task, since text follows the spaces", () => {
    const list = (parseMarkdown("- [ ]  a").content ?? [])[0];
    expect(list.type).toBe("taskList");
    const mixed = mixedOurs("- x\n- [ ]  a");
    expect(mixed[0]).toBe(true);
    expect(mixed).toEqual(mixedTheirs("- x\n- [ ]  a"));
  });

  // marked's `listIsTask` (`\S` after the checkbox's space) refuses a
  // no-break space, but a task whose text starts with one is written exactly
  // so, and has to read back as that task, alone or after a bullet.
  it("reads a checkbox, a space and text that starts with a no-break space as a task", () => {
    const source = "- [x] \u00a0a";
    const list = (parseMarkdown(source).content ?? [])[0];
    expect(list.type).toBe("taskList");
    expect((list.content ?? [])[0].attrs?.checked).toBe(true);
    expect(textOf(list)).toBe("\u00a0a");
    expect(mixedOurs(`- x\n${source}`)).toEqual([true, [["p", "\u00a0a"]]]);
    expect(mixedTheirs(`- x\n${source}`)[0]).toBe(false);
    const loose = parseMarkdown(`- x\n\n${source}\n\n  b`).content ?? [];
    const tasks = loose.find((node) => node.type === "taskList");
    expect(textOf(tasks ?? { type: "none" })).toBe("\u00a0ab");
  });

  // A checkbox with nothing after it is an empty task item, because the
  // serializer writes an empty task as its marker line and it has to read
  // back. marked reads it as a plain bullet whose text is `[ ]`.
  it("reads `- [ ] ` as an empty task item on its own and after a plain bullet (D7)", () => {
    const list = (parseMarkdown("- [ ] ").content ?? [])[0];
    expect(list.type).toBe("taskList");
    expect(textOf(list)).toBe("");
    expect(standaloneOurs("- [ ] ")).toEqual([true, [["p", ""]]]);
    expect(mixedOurs("- x\n- [ ] ")).toEqual([true, [["p", ""]]]);
    expect(mixedTheirs("- x\n- [ ] ")).toEqual([false, [["p", "[ ]"]]]);
  });
});

// ---- the mixed path reads a task item as the standalone path does

type ItemReading = readonly [string, unknown, Shape[]];

// The second item of the document, wherever the lists split: its node type,
// checked state and blocks.
function secondItem(source: string): ItemReading {
  const items = (parseMarkdown(source).content ?? [])
    .filter((node) => (node.type ?? "").endsWith("List"))
    .flatMap((list) =>
      (list.content ?? []).map((item): [string, JsonContent] => [
        item.type ?? "",
        item,
      ]),
    );
  const second = items.at(1);
  if (second === undefined) return ["none", undefined, []];
  return [second[0], second[1].attrs?.checked, oursShape(second[1])];
}

describe("a task item reads the same in a mixed list as in a list of tasks", () => {
  const CHECKS = [" ", "x", "X"];
  const BODIES = [
    "a",
    "[ ] a",
    "[x] a",
    "[X] a",
    "",
    "\u00a0",
    "\u2003",
    "\u3000",
    "\u00a0a",
  ];
  // Where a blank line goes: inside the item, before it, after it, at the end.
  const TIGHTNESS: ReadonlyArray<
    readonly [string, (task: string) => readonly [string, string]]
  > = [
    ["tight", (task) => [`${task}`, "- y"]],
    ["a second paragraph", (task) => [`${task}\n\n  b`, "- y"]],
    ["a blank line before it", (task) => [`\n${task}`, "- y"]],
    ["a blank line after it", (task) => [`${task}\n`, "- y"]],
    ["a blank line at the very end", (task) => [`${task}`, "- y\n\n"]],
  ];

  for (const position of ["in the middle", "last"]) {
    for (const [tightName, shape] of TIGHTNESS) {
      it(`agrees ${position}, ${tightName}`, () => {
        const mismatches: string[] = [];
        for (const check of CHECKS) {
          for (const body of BODIES) {
            const [task, tail] = shape(`- [${check}] ${body}`);
            const after = position === "last" ? "" : `\n${tail}`;
            const plain = `- x\n${task}${after}`;
            const tasks = `- [ ] x\n${task}${after.replace(/\n- y/, "\n- [ ] y")}`;
            if (
              JSON.stringify(secondItem(plain)) !==
              JSON.stringify(secondItem(tasks))
            ) {
              mismatches.push(JSON.stringify(plain));
            }
          }
        }
        expect(mismatches).toEqual([]);
      });
    }
  }

  // Top-level token boundaries: the sequence of types (a taskList counts as
  // a list), the raw of each token and the space tokens between lists.
  function boundaries(tokens: ReadonlyArray<MarkedToken>): string[][] {
    return tokens.map((token) => [
      token.type === "taskList" ? "list" : token.type,
      placeholderOf(token.raw ?? ""),
    ]);
  }

  const TOKEN_ROWS: ReadonlyArray<readonly [string, string]> = [
    ["a task list after a task list ends at its marker", "- [ ] a\n+ [ ] b"],
    ["a space token before a task list stays a space token", "- a\n\n+ [ ] b"],
    [
      "a plain list keeps its trailing newline before a task list",
      "- a\n  - [ ] n\n* [x] t",
    ],
  ];

  for (const [name, source] of TOKEN_ROWS) {
    it(`reads ${name} as marked does`, () => {
      expect(boundaries(oursLexer(source))).toEqual(
        boundaries(referenceLex(placeholderOf(source))),
      );
    });
  }

  it("keeps the space token between a plain list and a task list", () => {
    const types = oursLexer("- a\n\n+ [ ] b").map((token) => token.type);
    expect(types).toEqual(["list", "space", "taskList"]);
  });

  function items(source: string): JsonContent[] {
    return parseMarkdown(source).content ?? [];
  }

  function taskParagraphs(item: JsonContent): string[] {
    return (item.content ?? []).map((child) => {
      expect(child.type).toBe("paragraph");
      return textOf(child);
    });
  }

  it("keeps the text `[ ] ` a checked task holds, in a loose mixed list", () => {
    const top = items("- x\n- [x] [ ] a\n\n  b");
    expect(top.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
    expect(textOf(top[0])).toBe("x");
    const task = (top[1].content ?? [])[0];
    expect(task.attrs?.checked).toBe(true);
    expect(taskParagraphs(task)).toEqual(["[ ] a", "b"]);
  });

  it("keeps it with another task after it", () => {
    const top = items("- x\n- [x] [ ] a\n\n  b\n- [ ] c");
    expect(top.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
    const tasks = top[1].content ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks[0].attrs?.checked).toBe(true);
    expect(taskParagraphs(tasks[0])).toEqual(["[ ] a", "b"]);
    expect(tasks[1].attrs?.checked).toBe(false);
    expect(taskParagraphs(tasks[1])).toEqual(["c"]);
  });

  const EMPTY_CASES: ReadonlyArray<readonly [string, string, boolean, string]> =
    [
      ["a checked task of one extra space", "- x\n- [x]  ", true, ""],
      ["an unchecked task of one extra space", "- x\n- [ ]  ", false, ""],
      // Marked trims the last item's
      // no-break space away, the one reader keeps it.
      [
        "a checked task of a no-break space",
        "- x\n- [x] \u00a0",
        true,
        "\u00a0",
      ],
      [
        "an unchecked task of a no-break space",
        "- x\n- [ ] \u00a0",
        false,
        "\u00a0",
      ],
      ["a checked task of an em space", "- x\n- [x] \u2003", true, "\u2003"],
      [
        "a checked task of an ideographic space",
        "- x\n- [x] \u3000",
        true,
        "\u3000",
      ],
      [
        "an unchecked task of an em space",
        "- x\n- [ ] \u2003",
        false,
        "\u2003",
      ],
      [
        "an unchecked task of an ideographic space",
        "- x\n- [ ] \u3000",
        false,
        "\u3000",
      ],
    ];

  for (const [name, source, checked, text] of EMPTY_CASES) {
    it(`keeps ${name} after a bullet as a task and nothing after it`, () => {
      const top = items(source);
      expect(top.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
      expect(textOf(top[0])).toBe("x");
      const task = (top[1].content ?? [])[0];
      expect(task.attrs?.checked).toBe(checked);
      expect(taskParagraphs(task)).toEqual([text]);
    });
  }
});

// ---- plain-text ordered paste

describe("a plain-text ordered paste reads as marked reads it", () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit],
  });

  afterAll(() => {
    editor.destroy();
  });

  function isClipboardEvent(event: Event): event is ClipboardEvent {
    return "clipboardData" in event;
  }

  function paste(text: string, html: string): boolean {
    const event = createEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => {
          if (type === "text/plain") return text;
          return type === "text/html" ? html : "";
        },
      },
    });
    if (!isClipboardEvent(event)) throw new Error("not a clipboard event");
    const view = editor.view;
    return (
      view.someProp("handlePaste", (handler) =>
        handler(view, event, Slice.empty),
      ) === true
    );
  }

  function insertedItems(): string[] | null {
    const list = editor.state.doc.children.find(
      (node) => node.type.name === "orderedList",
    );
    if (list === undefined) return null;
    return list.children.map((item) => item.firstChild?.textContent ?? "");
  }

  function markedItems(
    source: string,
  ): readonly [number, ReadonlyArray<string>] | string {
    const blocks = lex(source).filter((token) => token.type !== "space");
    if (blocks.length !== 1 || blocks[0].type !== "list") {
      return "not-one-list";
    }
    const items = blocks[0].items ?? [];
    const texts: string[] = [];
    for (const item of items) {
      const shape = theirsShape(item.tokens ?? []);
      if (shape.length !== 1 || shape[0][0] !== "p") return "blocks";
      texts.push((item.text ?? "").replace(/\n+$/, ""));
    }
    return [items.length, texts];
  }

  it("accepts only what marked reads as one list of single-paragraph items, with the same texts", () => {
    const PASTE_MARKERS = [
      ["1.", "2."],
      ["10.", "11."],
      ["100.", "101."],
    ] as const;
    const TAILS = ["", "\t", "  ", "b\tc"];
    const corpus = PASTE_MARKERS.flatMap(([first, second]) =>
      GAPS.flatMap((gap) =>
        PREFIXES.flatMap((prefix) =>
          UNIS.flatMap((uni) =>
            TAILS.flatMap((tail) => [
              `${first}${gap}${uni}a${tail}`,
              `${first}${gap}a${tail}\n${prefix}${second}${gap}${uni}b`,
              `${first}${gap}a\n\n${prefix}${second}${gap}b${tail}`,
              `${prefix}${first}${gap}a${tail}`,
            ]),
          ),
        ),
      ),
    );
    let accepted = 0;
    const mismatches: string[] = [];
    for (const source of corpus) {
      if (!paste(source, "")) continue;
      accepted++;
      const mine = insertedItems();
      editor.commands.clearContent();
      editor.commands.focus("start");
      const reference = markedItems(source);
      if (
        mine === null ||
        typeof reference === "string" ||
        JSON.stringify([mine.length, mine]) !== JSON.stringify(reference)
      ) {
        mismatches.push(JSON.stringify(source));
      }
    }
    expect(mismatches).toEqual([]);
    expect(corpus.length).toBe(56448);
    expect(accepted).toBe(14128);
  }, 120000);

  it("treats a clipboard whose HTML is a lone non-breaking space as HTML", () => {
    expect(paste("1. a\n2. b", "\u00a0")).toBe(false);
    expect(insertedItems()).toBeNull();
  });

  it("lets the plain-text list through when the HTML is only spaces and newlines", () => {
    expect(paste("1. a\n2. b", " \n ")).toBe(true);
    expect(insertedItems()).toEqual(["a", "b"]);
    editor.commands.clearContent();
    editor.commands.focus("start");
  });

  it("maps list-style-type to an ordered list type only for CSS whitespace", () => {
    function typeOf(html: string): unknown {
      editor.commands.setContent(html);
      const list = editor.state.doc.children.find(
        (node) => node.type.name === "orderedList",
      );
      const type: unknown = list?.attrs.type;
      return type;
    }
    expect(
      typeOf('<ol style="list-style-type: lower-alpha"><li>a</li></ol>'),
    ).toBe("a");
    expect(
      typeOf('<ol style="list-style-type:\u00a0lower-alpha"><li>a</li></ol>'),
    ).not.toBe("a");
    expect(
      typeOf('<ol style="list-style-type:\n lower-alpha "><li>a</li></ol>'),
    ).toBe("a");
    editor.commands.clearContent();
  });

  it("leaves a paste it does not accept to the default handler", () => {
    for (const source of ["1. a\n- x", "x\n1. a", "1. a\n```", "- a"]) {
      expect(paste(source, "")).toBe(false);
    }
    expect(insertedItems()).toBeNull();
  });
});

// ---- the added rows

describe("a continuation line's tabs read as marked reads them", () => {
  const ROWS: ReadonlyArray<readonly [string, string]> = [
    ["1. a\n    \tb", "a\n b"],
    ["- [ ] a\n    \tb", "a\n  b"],
    ["- a\n    \tb", "a\n  b"],
    ["1. a\n   \t\tb", "a\n    b"],
    ["- [ ] a\n   \t\tb", "a\n     b"],
    ["- a\n   \t\tb", "a\n     b"],
    ["10. a\n \t b", "a\n  b"],
    ["1.\ta\n\t\tb", "a\nb"],
  ];

  for (const [source, expected] of ROWS) {
    it(`reads ${JSON.stringify(source)} as ${JSON.stringify(expected)}`, () => {
      const list = (parseMarkdown(source).content ?? [])[0];
      const item = (list.content ?? [])[0];
      const paragraph = (item.content ?? [])[0];
      expect(textOf(paragraph)).toBe(expected);
      const marked = theirsReading(source, false);
      expect(marked).toEqual([1, [[["p", expected]]]]);
    });
  }
});

// ---- whole documents: lists of mixed markers, tasks and blank lines

// The reference is the same document with each checkbox swapped for a
// same-width placeholder, which marked reads as a plain list with no task.

type ItemKind = "plain" | "task" | "done";
type Variant = "none" | "para" | "nested" | "nestedBlank" | "nestedTask";

interface ItemSpec {
  readonly kind: ItemKind;
  readonly variant: Variant;
}

interface ListSpec {
  readonly marker: string;
  readonly items: ReadonlyArray<ItemSpec>;
  readonly separators: ReadonlyArray<string>;
}

const ITEM_KINDS: ReadonlyArray<ItemKind> = ["plain", "task", "done"];
const VARIANTS: ReadonlyArray<Variant> = [
  "none",
  "para",
  "nested",
  "nestedBlank",
  "nestedTask",
];
const LIST_MARKERS = ["-", "+", "*"];
const ITEM_SEPARATORS = ["\n", "\n\n"];

function itemSource(marker: string, spec: ItemSpec): string {
  const head: Record<ItemKind, string> = {
    plain: `${marker} a`,
    task: `${marker} [ ] t`,
    done: `${marker} [x] t`,
  };
  const tail: Record<Variant, string> = {
    none: "",
    para: "\n\n  b",
    nested: "\n  - x",
    nestedBlank: "\n\n  - x",
    nestedTask: "\n  - [ ] n",
  };
  return `${head[spec.kind]}${tail[spec.variant]}`;
}

function listSource(list: ListSpec): string {
  return list.items
    .map((item, index) => {
      const before = index === 0 ? "" : list.separators[index - 1];
      return `${before}${itemSource(list.marker, item)}`;
    })
    .join("");
}

function placeholderOf(source: string): string {
  return source.replace(/\[([ x])\]/g, "{$1}");
}

// A small seeded generator keeps the corpus fixed from run to run.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exhaustiveLists(): ListSpec[] {
  const items: ItemSpec[] = ITEM_KINDS.flatMap((kind) =>
    VARIANTS.map((variant): ItemSpec => ({ kind, variant })),
  );
  const lists: ListSpec[] = [];
  for (const marker of LIST_MARKERS) {
    for (const one of items) {
      lists.push({ marker, items: [one], separators: [] });
      for (const two of items) {
        for (const separator of ITEM_SEPARATORS) {
          lists.push({ marker, items: [one, two], separators: [separator] });
        }
      }
    }
  }
  return lists;
}

function pick<T>(random: () => number, values: ReadonlyArray<T>): T {
  return values[Math.floor(random() * values.length)];
}

function randomList(random: () => number): ListSpec {
  const count = 1 + Math.floor(random() * 3);
  const items: ItemSpec[] = [];
  const separators: string[] = [];
  for (let index = 0; index < count; index++) {
    items.push({
      kind: pick(random, ITEM_KINDS),
      variant: pick(random, VARIANTS),
    });
    if (index > 0) separators.push(pick(random, ITEM_SEPARATORS));
  }
  return { marker: pick(random, LIST_MARKERS), items, separators };
}

function wholeDocuments(): string[] {
  const documents = exhaustiveLists().map(listSource);
  const random = seeded(2357);
  for (let index = 0; index < 6000; index++) {
    const lists = 1 + Math.floor(random() * 3);
    const parts: string[] = [];
    for (let part = 0; part < lists; part++) {
      parts.push(listSource(randomList(random)));
    }
    documents.push(parts.join(pick(random, ["\n", "\n\n"])));
  }
  return documents;
}

const CHECKBOX = /\[[ x]\]/;
const PLACEHOLDER_TASK = /^[ \t]*[-+*][ \t]+\{[ x]\}/;

function referenceLex(source: string): MarkedToken[] {
  const tokens: unknown[] = new Lexer().lex(source);
  return tokens.filter(isMarkedToken);
}

function oursLexer(source: string): MarkedToken[] {
  // The lexer `MarkdownManager.parse` uses, with our tokenizers registered.
  const instance = artifactDocumentBundle.markdownManager.instance;
  const tokens: unknown[] = new instance.Lexer(instance.defaults).lex(source);
  return tokens.filter(isMarkedToken);
}

// True when `mine` holds every key marked's token holds, to any depth, with
// the same value. Our list items carry extra keys of their own.
function covers(mine: unknown, marked: unknown): boolean {
  if (Array.isArray(marked)) {
    return (
      Array.isArray(mine) &&
      mine.length === marked.length &&
      marked.every((entry, index) => covers(mine.at(index), entry))
    );
  }
  if (typeof marked === "object" && marked !== null) {
    if (typeof mine !== "object" || mine === null) return false;
    const own = new Map(Object.entries(mine));
    return Object.entries(marked).every(([key, value]) =>
      covers(own.get(key), value),
    );
  }
  return Object.is(mine, marked);
}

function isListToken(token: MarkedToken): boolean {
  return token.type === "list" || token.type === "taskList";
}

function compareTokens(source: string): string[] {
  const reference = referenceLex(placeholderOf(source));
  const ours = oursLexer(source);
  const problems: string[] = [];
  if (ours.length !== reference.length)
    return [`token count: ${JSON.stringify(source)}`];
  reference.forEach((marked, index) => {
    const mine = ours.at(index);
    if (mine === undefined) return;
    if (placeholderOf(mine.raw ?? "") !== marked.raw) {
      problems.push(`raw: ${JSON.stringify(source)}`);
      return;
    }
    if (marked.type === "list")
      problems.push(...compareListToken(source, mine, marked));
  });
  return problems;
}

function compareListToken(
  source: string,
  mine: MarkedToken,
  marked: MarkedToken,
): string[] {
  const label = JSON.stringify(source);
  const mineItems = mine.items ?? [];
  const markedItems = marked.items ?? [];
  if (!isListToken(mine)) return [`list type: ${label}`];
  if (mine.loose !== marked.loose) return [`loose: ${label}`];
  if (mineItems.length !== markedItems.length) return [`item count: ${label}`];
  const problems: string[] = [];
  markedItems.forEach((markedItem, index) => {
    const item = mineItems.at(index);
    if (item === undefined) return;
    // A task item's own token keeps no raw text, so it is checked by type:
    // the reference item opens with a placeholder checkbox.
    if (PLACEHOLDER_TASK.test(markedItem.raw ?? "")) {
      if (item.type !== "taskItem") problems.push(`task type: ${label}`);
      return;
    }
    if (item.type !== "list_item") {
      problems.push(`plain type: ${label}`);
    } else if (placeholderOf(item.raw ?? "") !== markedItem.raw) {
      problems.push(`item raw: ${label}`);
    } else if (!CHECKBOX.test(item.raw ?? "") && !covers(item, markedItem)) {
      problems.push(`plain item: ${label}`);
    }
  });
  return problems;
}

function topBlocks(doc: JsonContent): JsonContent[] {
  return (doc.content ?? []).filter((node) =>
    (node.type ?? "").endsWith("List"),
  );
}

const TASK_PREFIX = /^\{([ x])\} /;

// A task inside a plain item reads back as the placeholder list it replaced.
function asPlaceholder(node: JsonContent): JsonContent {
  const content = (node.content ?? []).map(asPlaceholder);
  if (node.type === "taskList") return { type: "bulletList", content };
  if (node.type !== "taskItem") {
    return node.content === undefined ? node : { ...node, content };
  }
  const box = node.attrs?.checked === true ? "{x} " : "{ } ";
  const [first, ...rest] = content;
  const text = { type: "text", text: `${box}${textOf(first)}` };
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: [text] }, ...rest],
  };
}

function compareItem(
  label: string,
  mine: JsonContent,
  marked: JsonContent,
  itemRaw: string,
): string[] {
  const markedText = textOf((marked.content ?? [])[0]);
  const box = TASK_PREFIX.exec(markedText);
  if (mine.type !== "taskItem") {
    const same = JSON.stringify(asPlaceholder(mine)) === JSON.stringify(marked);
    return box === null && same ? [] : [`plain item node: ${label}`];
  }
  if (box === null) return [`task for a plain item: ${label}`];
  const problems: string[] = [];
  if (mine.attrs?.checked !== (box[1] === "x"))
    problems.push(`checked: ${label}`);
  if (textOf((mine.content ?? [])[0]) !== markedText.replace(TASK_PREFIX, "")) {
    problems.push(`task text: ${label}`);
  }
  const alone = (parseMarkdown(itemRaw).content ?? []).at(0);
  const standalone = (alone?.content ?? []).at(0);
  if (JSON.stringify(standalone) !== JSON.stringify(mine)) {
    problems.push(`standalone reader: ${label}`);
  }
  return problems;
}

function compareDocument(source: string): string[] {
  const label = JSON.stringify(source);
  const referenceTokens = referenceLex(placeholderOf(source));
  const lists = referenceTokens.filter((token) => token.type === "list");
  const blocks = topBlocks(parseMarkdown(source));
  const referenceBlocks = topBlocks(parseMarkdown(placeholderOf(source)));
  const problems: string[] = [];
  let cursor = 0;
  lists.forEach((marked, listIndex) => {
    const expected = (marked.items ?? []).length;
    const reference = referenceBlocks.at(listIndex);
    const items: JsonContent[] = [];
    let previousType = "";
    while (items.length < expected) {
      const block = blocks.at(cursor);
      if (block === undefined || block.type === previousType) {
        problems.push(`run: ${label}`);
        return;
      }
      previousType = block.type ?? "";
      items.push(...(block.content ?? []));
      cursor++;
    }
    if (items.length !== expected) {
      problems.push(`run size: ${label}`);
      return;
    }
    const raws = (marked.items ?? []).map((item) =>
      (item.raw ?? "").replace(/\{([ x])\}/g, "[$1]"),
    );
    items.forEach((item, index) => {
      const markedItem = (reference?.content ?? []).at(index);
      if (markedItem === undefined) return;
      problems.push(
        ...compareItem(label, item, markedItem, raws.at(index) ?? ""),
      );
    });
  });
  if (cursor !== blocks.length) problems.push(`extra blocks: ${label}`);
  return problems;
}

describe("a whole document of lists reads as marked reads it", () => {
  const documents = wholeDocuments();

  it("has no extensions on the reference lexer", () => {
    expect(referenceLex("- [ ] a").at(0)?.type).toBe("list");
    expect(oursLexer("- [ ] a").at(0)?.type).toBe("taskList");
    const mixed = oursLexer("- a\n- [ ] b").at(0);
    expect(mixed?.type).toBe("list");
    expect(mixed?.items?.at(1)?.type).toBe("taskItem");
    expect(mixed?.items?.at(0)?.type).toBe("list_item");
  });

  it("splits the tokens where marked does and reads every plain item as marked does", () => {
    const problems = documents.flatMap(compareTokens);
    expect(documents.length).toBe(CORPUS_SIZE);
    expect({ count: problems.length, first: problems.slice(0, 5) }).toEqual({
      count: 0,
      first: [],
    });
  }, 120000);

  it("maps each marked list to a run of our lists and each task item to the standalone reader", () => {
    const problems = documents.flatMap(compareDocument);
    expect(problems.slice(0, 5)).toEqual([]);
  }, 120000);

  function items(source: string): JsonContent[] {
    return parseMarkdown(source).content ?? [];
  }

  it("holds a plain item's second paragraph with no empty paragraph before it", () => {
    const top = items("- a\n\n  b\n- [ ] task");
    expect(top.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
    const plain = (top[0].content ?? [])[0];
    expect((plain.content ?? []).map((child) => child.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect((plain.content ?? []).map(textOf)).toEqual(["a", "b"]);
    const task = (top[1].content ?? [])[0];
    expect(task.attrs?.checked).toBe(false);
    expect((task.content ?? []).map(textOf)).toEqual(["task"]);
  });

  it("holds a nested list directly after a plain item's text in a loose list", () => {
    const top = items("- a\n\n  - x\n- [ ] task");
    expect(top.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
    const plain = (top[0].content ?? [])[0];
    expect((plain.content ?? []).map((child) => child.type)).toEqual([
      "paragraph",
      "bulletList",
    ]);
    expect(textOf((plain.content ?? [])[0])).toBe("a");
  });

  it("ends a list at a different bullet character", () => {
    const top = items("- a\n+ b\n- [ ] c");
    expect(top.map((node) => node.type)).toEqual([
      "bulletList",
      "bulletList",
      "taskList",
    ]);
    expect(top.map(textOf)).toEqual(["a", "b", "c"]);
  });
});
