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

describe("a task item in a list that opens with a bullet reads as marked reads it", () => {
  it("matches marked's second item over gap, prefix, Unicode space and second line", () => {
    const corpus = GAPS.flatMap((gap) =>
      PREFIXES.flatMap((prefix) =>
        UNIS.flatMap((uni) =>
          KINDS.map(([, build]) => `- x\n- [ ]${gap}a\n${build(prefix + uni)}`),
        ),
      ),
    );
    const mismatches = corpus
      .filter(
        (source) =>
          JSON.stringify(mixedOurs(source)) !==
          JSON.stringify(mixedTheirs(source)),
      )
      .map((source) => JSON.stringify(source));
    expect(corpus.length).toBe(4704);
    expect(mismatches).toEqual([]);
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

  // D6: marked's `listIsTask` (`\S` after the checkbox's space) refuses a
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

  it("keeps `- [ ] ` a task on its own, and a plain bullet after another bullet as marked reads it", () => {
    const list = (parseMarkdown("- [ ] ").content ?? [])[0];
    expect(list.type).toBe("taskList");
    expect(textOf(list)).toBe("");
    expect(mixedOurs("- x\n- [ ] ")).toEqual(mixedTheirs("- x\n- [ ] "));
  });
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

// ---- the cold reviewer's rows

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
