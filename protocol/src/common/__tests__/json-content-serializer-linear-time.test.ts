import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import {
  jsonContentToArtifactMarkdown,
  jsonContentToMarkdown,
  unresolvedArtifactImageText,
} from "../json-content-serializer";

/**
 * Growth rows for the serializer's whitespace and delimiter scans. Each row
 * serializes one input at N and at 4N and requires the larger run to cost
 * about 4x the smaller, not 16x: a backtracking regex over a long run of
 * spaces, dashes or pipes that ends in a character it cannot match retries the
 * run from each of its positions, which is quadratic. There is deliberately no
 * absolute ceiling, so a slow machine cannot fail a linear scan.
 */

const OPTIONS = { mentionFormat: "llm", platform: "POSIX" } as const;

interface Sizes {
  readonly small: number;
  readonly large: number;
}

const STANDARD: Sizes = { small: 16_000, large: 64_000 };
// The same 4x apart at half the size, for the rows where the quadratic form
// costs the most: before the fix each takes about 10 s, where STANDARD took 41 s.
const REDUCED: Sizes = { small: 8_000, large: 32_000 };

type Serializer = (content: JsonContent) => string;

const artifact: Serializer = (content) =>
  jsonContentToArtifactMarkdown(content, OPTIONS);
const prompt: Serializer = (content) => jsonContentToMarkdown(content, OPTIONS);

interface Row {
  readonly name: string;
  readonly sizes: Sizes;
  readonly build: (size: number) => JsonContent;
}

function paragraphOf(
  value: string,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }>,
): JsonContent {
  return {
    type: "paragraph",
    content: [
      marks.length > 0
        ? { type: "text", text: value, marks }
        : { type: "text", text: value },
    ],
  };
}

function docOf(...content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

// The best of a few runs, so one scheduling hiccup is not the measurement.
function best(content: JsonContent, serialize: Serializer): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    serialize(content);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

function expectLinear(
  build: (size: number) => JsonContent,
  serialize: Serializer,
  sizes: Sizes,
): void {
  const smallTime = best(build(sizes.small), serialize);
  const largeTime = best(build(sizes.large), serialize);
  expect(largeTime).toBeLessThan(6 * smallTime + 50);
}

const fallback = (size: number): string =>
  unresolvedArtifactImageText("a\n" + "-".repeat(size) + "x", "images/x.png");

describe("artifact serializer: delimiter and whitespace scans grow linearly", () => {
  it("writes a fallback whose later label line only nearly looks like punctuation, in linear time and as it is", () => {
    expectLinear(
      (size) => docOf(paragraphOf(fallback(size), [])),
      artifact,
      STANDARD,
    );
    expect(artifact(docOf(paragraphOf(fallback(STANDARD.small), [])))).toBe(
      fallback(STANDARD.small),
    );
  });

  it("joins the lines of an alt that cannot keep them, in linear time", () => {
    expectLinear(
      (size) =>
        docOf({
          type: "image",
          attrs: {
            alt: "a\n\nx" + " ".repeat(size) + "x",
            src: "images/x.png",
          },
        }),
      artifact,
      REDUCED,
    );
  });

  it("scans a later line that nearly is a table delimiter row in linear time", () => {
    expectLinear(
      (size) => docOf(paragraphOf("a\n|-" + " ".repeat(size) + "x", [])),
      artifact,
      REDUCED,
    );
  });

  describe("a space run in the middle of a line", () => {
    const run = (size: number): string => "a" + " ".repeat(size) + "b";
    const rows: readonly Row[] = [
      {
        name: "a paragraph's later line",
        sizes: REDUCED,
        build: (size) => docOf(paragraphOf("a\n" + run(size), [])),
      },
      {
        name: "a paragraph",
        sizes: REDUCED,
        build: (size) => docOf(paragraphOf(run(size), [])),
      },
      {
        name: "a heading",
        sizes: REDUCED,
        build: (size) =>
          docOf({
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: run(size) }],
          }),
      },
      {
        name: "a bold run",
        sizes: REDUCED,
        build: (size) => docOf(paragraphOf(run(size), [{ type: "bold" }])),
      },
      {
        name: "a code mark",
        sizes: REDUCED,
        build: (size) => docOf(paragraphOf(run(size), [{ type: "code" }])),
      },
      {
        name: "a link whose text and href are the same string",
        sizes: REDUCED,
        build: (size) =>
          docOf(
            paragraphOf(run(size), [
              { type: "link", attrs: { href: run(size) } },
            ]),
          ),
      },
      {
        name: "a table cell",
        sizes: REDUCED,
        build: (size) =>
          docOf({
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableHeader",
                    content: [paragraphOf("h", [])],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [paragraphOf(run(size), [])],
                  },
                ],
              },
            ],
          }),
      },
      {
        name: "a code block",
        sizes: REDUCED,
        build: (size) =>
          docOf({
            type: "codeBlock",
            attrs: { language: "" },
            content: [{ type: "text", text: run(size) }],
          }),
      },
      {
        name: "an image src",
        sizes: REDUCED,
        build: (size) =>
          docOf({
            type: "image",
            attrs: { alt: "x", src: run(size) },
          }),
      },
      {
        name: "a tab run in a paragraph",
        sizes: REDUCED,
        build: (size) => docOf(paragraphOf("a" + "\t".repeat(size) + "b", [])),
      },
    ];

    it.each(rows)("in $name", ({ build, sizes }) => {
      expectLinear(build, artifact, sizes);
    });
  });

  it("trims a later-line run of blank lines that each hold a space, in linear time", () => {
    expectLinear(
      (size) => docOf(paragraphOf("a\n" + " \n".repeat(size / 2) + "x", [])),
      artifact,
      STANDARD,
    );
  });
});

describe("prompt serializer: whitespace trim grows linearly", () => {
  // The prompt serializer shares `normalizeMarkdown` with the artifact one, so
  // the quadratic trim was there before this change: this row is red on main
  // too, not only on the commit that moved the artifact path onto scans.
  it("serializes a space run in the middle of a paragraph's later line in linear time", () => {
    expectLinear(
      (size) => docOf(paragraphOf("a\n" + "a" + " ".repeat(size) + "b", [])),
      prompt,
      REDUCED,
    );
  });
});
