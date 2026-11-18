import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { describe, expect, it } from "vitest";
import { READERS, textsOf, type IngestReader } from "./artifact-ingest-readers";

/**
 * Growth rows for the whitespace trims the patched tiptap packages run while a
 * Markdown or HTML body is read (`patches/@tiptap%2F{core,extension-list,
 * markdown}@3.30.1.patch`). Each row reads one input at N and at 4N through the
 * real readers and requires the larger run to cost about 4x the smaller, not
 * 16x: `.replace(/[ \t\n]+$/, "")` retries a long whitespace run that sits
 * INSIDE the text from every position of the run, which is quadratic. There is
 * deliberately no absolute ceiling, so a slow machine cannot fail a linear
 * scan.
 */

interface Sizes {
  readonly small: number;
  readonly large: number;
}

const SIZES: Sizes = { small: 8_000, large: 32_000 };

interface Reading {
  readonly name: string;
  readonly read: (markup: string) => JsonContent;
}

interface Row {
  readonly name: string;
  /**
   * Whether the host reader takes this row. Its parse runs on the stock
   * `marked` singleton, whose own inline text scan is quadratic in a run of
   * spaces or tabs inside a line (`Lexer.lex("a" + " ".repeat(n) + "b")` costs
   * about 14 ms at 4k and 220 ms at 16k with the patches out of the picture),
   * so a row that puts the run in a paragraph's text measures marked there
   * and not the trims. The gui reader's isolated `marked` does not have that
   * cost, so it takes every row; the host reader takes the rows whose run
   * never reaches an inline text scan.
   */
  readonly hostReads: boolean;
  readonly build: (size: number) => string;
  /** Throws (via expect) when the document read for `build(size)` is wrong. */
  readonly expectShape: (doc: JsonContent) => void;
}

function findAll(node: JsonContent, type: string): JsonContent[] {
  return (node.type === type ? [node] : []).concat(
    (node.content ?? []).flatMap((child) => findAll(child, type)),
  );
}

function firstOf(doc: JsonContent, type: string): JsonContent {
  const found = findAll(doc, type).at(0);
  if (found === undefined) {
    throw new Error(`No ${type} in ${JSON.stringify(doc).slice(0, 300)}`);
  }
  return found;
}

function flatText(node: JsonContent): string {
  return textsOf(node).join("");
}

// The best of a few runs, so one scheduling hiccup is not the measurement.
function best(markup: string, read: (markup: string) => JsonContent): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    read(markup);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

const MARKDOWN_READINGS: readonly Reading[] = READERS.map(
  (reader: IngestReader) => ({ name: reader.name, read: reader.stored }),
);

const rows: readonly Row[] = [
  {
    name: "an ordered item with a space run inside its text",
    hostReads: false,
    build: (size) => "1. a" + " ".repeat(size) + "b",
    expectShape: (doc) => {
      const list = firstOf(doc, "orderedList");
      expect(list.content).toHaveLength(1);
      const text = flatText(list);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("b")).toBe(true);
    },
  },
  {
    name: "a task item with a space run inside its text",
    hostReads: false,
    build: (size) => "- [ ] a" + " ".repeat(size) + "b",
    expectShape: (doc) => {
      const list = firstOf(doc, "taskList");
      expect(list.content).toHaveLength(1);
      const text = flatText(list);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("b")).toBe(true);
    },
  },
  {
    name: "a bullet item with a space run inside its text",
    hostReads: false,
    build: (size) => "- a" + " ".repeat(size) + "b",
    expectShape: (doc) => {
      const list = firstOf(doc, "bulletList");
      expect(list.content).toHaveLength(1);
      const text = flatText(list);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("b")).toBe(true);
    },
  },
  {
    name: "an ordered item whose continuation line holds a space run",
    hostReads: false,
    build: (size) => "1. a\n   b" + " ".repeat(size) + "c",
    expectShape: (doc) => {
      const list = firstOf(doc, "orderedList");
      expect(list.content).toHaveLength(1);
      const text = flatText(list);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("c")).toBe(true);
    },
  },
  {
    name: "an ordered item whose later indented block holds a space run",
    hostReads: false,
    build: (size) => "1. a\n\n   b" + " ".repeat(size) + "c",
    expectShape: (doc) => {
      const list = firstOf(doc, "orderedList");
      expect(list.content).toHaveLength(1);
      const item = firstOf(list, "listItem");
      expect(item.content).toHaveLength(2);
      const text = flatText(list);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("c")).toBe(true);
    },
  },
  {
    // `<div>` is a recognized tag and is read through the DOM, which never
    // reaches `htmlAsLiteralText`; an unrecognized tag opens a type 7 HTML
    // block that is kept as literal text, and that is where the trim runs.
    name: "an HTML block of an unrecognized tag with a space run inside it",
    hostReads: true,
    build: (size) => "<enter>\n" + " ".repeat(size) + "x</enter>",
    expectShape: (doc) => {
      expect(doc.content).toHaveLength(1);
      const text = flatText(doc);
      expect(text.startsWith("<enter>")).toBe(true);
      expect(text.endsWith("x</enter>")).toBe(true);
    },
  },
  {
    name: "an ordered item with a tab run inside its text",
    hostReads: false,
    build: (size) => "1. a" + "\t".repeat(size) + "b",
    expectShape: (doc) => {
      const list = firstOf(doc, "orderedList");
      expect(list.content).toHaveLength(1);
      const text = flatText(list);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("b")).toBe(true);
    },
  },
  {
    // Two long blank lines, not thousands of short ones: every blank line
    // before an indented continuation becomes a separate token, and that
    // per-line cost grows with the line count whatever the trims do.
    name: "an ordered item whose blank lines hold long space runs",
    hostReads: true,
    build: (size) =>
      "1. a\n" + (" ".repeat(size / 2) + "\n").repeat(2) + "   b",
    expectShape: (doc) => {
      const list = firstOf(doc, "orderedList");
      expect(list.content).toHaveLength(1);
      const item = firstOf(list, "listItem");
      expect(item.content).toHaveLength(2);
      expect(flatText(list)).toBe("ab");
    },
  },
];

// The `list-style-type` value trim runs when an `<ol style>` is read from
// HTML (a paste or a loaded document), not when Markdown is read, so this
// reading builds the real editor on the patched StarterKit and sets the HTML.
const HTML_READING: Reading = {
  name: "StarterKit editor (HTML)",
  read: (html) => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      content: html,
    });
    try {
      return editor.getJSON();
    } finally {
      editor.destroy();
    }
  },
};

const htmlRow: Row = {
  name: "an ordered list whose list-style-type value holds a space run",
  hostReads: false,
  build: (size) =>
    '<ol style="list-style-type: lower-alpha' +
    " ".repeat(size) +
    'x"><li>a</li></ol>',
  expectShape: (doc) => {
    const list = firstOf(doc, "orderedList");
    expect(list.content).toHaveLength(1);
    expect(flatText(list)).toBe("a");
  },
};

interface Case {
  readonly reading: Reading;
  readonly row: Row;
}

const cases: readonly Case[] = [
  ...MARKDOWN_READINGS.flatMap((reading) =>
    rows
      .filter((row) => reading.name === "gui" || row.hostReads)
      .map((row) => ({ reading, row })),
  ),
  { reading: HTML_READING, row: htmlRow },
];

describe("patched tiptap readers: whitespace trims grow linearly", () => {
  it.each(cases)("$reading.name reads $row.name", ({ reading, row }) => {
    row.expectShape(reading.read(row.build(SIZES.small)));
    const smallTime = best(row.build(SIZES.small), reading.read);
    const largeTime = best(row.build(SIZES.large), reading.read);
    expect(largeTime).toBeLessThan(6 * smallTime + 50);
  });
});
