import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { artifactDocumentBundle } from "../artifact-document-bundle";

/**
 * Growth rows for the artifact Markdown import parse
 * (`artifactDocumentBundle.markdownManager.parse`). Each row parses one body
 * at N and at 4N characters and requires the larger parse to cost well under
 * the 16x a quadratic scan would. Every block tokenizer registered on the
 * manager's marked must do work proportional to its own block, not to the rest
 * of the body, so a newly registered tokenizer that scans the whole remaining
 * body at every block position reddens these rows. There is deliberately no
 * absolute ceiling, so a slow machine cannot fail a linear parse.
 */

const SIZES = { small: 100_000, large: 400_000 };
const MAX_GROWTH = 6;
const GROWTH_TIMEOUT_MS = 120_000;

function parse(markdown: string): JSONContent {
  return artifactDocumentBundle.markdownManager.parse(markdown);
}

function findAll(node: JSONContent, type: string): JSONContent[] {
  return (node.type === type ? [node] : []).concat(
    (node.content ?? []).flatMap((child) => findAll(child, type)),
  );
}

function flatText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(flatText).join("");
}

function isChecked(node: JSONContent): boolean {
  const attrs = node.attrs;
  return attrs !== undefined && attrs.checked === true;
}

function repeatUntil(unit: (i: number) => string, length: number): string {
  let out = "";
  let i = 0;
  while (out.length < length) {
    out += unit(i);
    i += 1;
  }
  return out;
}

function unitsIn(unit: (i: number) => string, length: number): number {
  let total = 0;
  let i = 0;
  while (total < length) {
    total += unit(i).length;
    i += 1;
  }
  return i;
}

// The best of a few runs, so one scheduling hiccup is not the measurement.
function best(markdown: string): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    parse(markdown);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

function growth(unit: (i: number) => string): number {
  parse(repeatUntil(unit, 5_000));
  const smallTime = best(repeatUntil(unit, SIZES.small));
  const largeTime = best(repeatUntil(unit, SIZES.large));
  return largeTime / smallTime;
}

const section = (i: number): string =>
  `## Step ${i}\n\nRan the job and checked the output **carefully**.\n\n- item a ${i}\n- item b\n\n`;
const paragraph = (i: number): string =>
  `Ran the job ${i} and checked the output.\n\n`;

describe("artifact Markdown import parse grows linearly", () => {
  it(
    "reads a body of sections (heading, paragraph, bullets)",
    () => {
      const doc = parse(repeatUntil(section, SIZES.small));
      const units = unitsIn(section, SIZES.small);
      expect(findAll(doc, "heading")).toHaveLength(units);
      expect(findAll(doc, "bulletList")).toHaveLength(units);
      expect(growth(section)).toBeLessThan(MAX_GROWTH);
    },
    GROWTH_TIMEOUT_MS,
  );

  it(
    "reads a body of blank-line-separated paragraphs",
    () => {
      const doc = parse(repeatUntil(paragraph, SIZES.small));
      expect(
        findAll(doc, "paragraph").filter((p) => flatText(p) !== ""),
      ).toHaveLength(unitsIn(paragraph, SIZES.small));
      expect(growth(paragraph)).toBeLessThan(MAX_GROWTH);
    },
    GROWTH_TIMEOUT_MS,
  );
});

describe("task lists read exactly across the scan window edge", () => {
  it.each([63, 64, 65, 129, 300])(
    "a list of %i items then a paragraph",
    (n) => {
      const list = Array.from(
        { length: n },
        (_, i) => `- [${i % 2 === 1 ? "x" : " "}] task ${i}`,
      ).join("\n");
      const doc = parse(`${list}\n\nAfter the list.`);

      const lists = findAll(doc, "taskList");
      expect(lists).toHaveLength(1);
      const items = findAll(lists[0], "taskItem");
      expect(items.map(flatText)).toEqual(
        Array.from({ length: n }, (_, i) => `task ${i}`),
      );
      expect(items.map(isChecked)).toEqual(
        Array.from({ length: n }, (_, i) => i % 2 === 1),
      );
      const paragraphs = (doc.content ?? []).filter(
        (c) => c.type === "paragraph",
      );
      expect(paragraphs.map(flatText)).toEqual(["After the list."]);
    },
  );
});

describe("ordered lists read exactly across the scan window edge", () => {
  it.each([63, 64, 65, 129, 300])(
    "a list of %i items then a paragraph",
    (n) => {
      const list = Array.from(
        { length: n },
        (_, i) => `${i + 1}. item ${i}`,
      ).join("\n");
      const doc = parse(`${list}\n\nAfter the list.`);

      const lists = findAll(doc, "orderedList");
      expect(lists).toHaveLength(1);
      expect(findAll(lists[0], "listItem").map(flatText)).toEqual(
        Array.from({ length: n }, (_, i) => `item ${i}`),
      );
      const paragraphs = (doc.content ?? []).filter(
        (c) => c.type === "paragraph",
      );
      expect(paragraphs.map(flatText)).toEqual(["After the list."]);
    },
  );
});
