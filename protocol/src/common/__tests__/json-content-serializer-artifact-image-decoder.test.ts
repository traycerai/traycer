import { describe, expect, it } from "vitest";

import {
  decodeUnresolvedArtifactImageText,
  unresolvedArtifactImageText,
} from "../json-content-serializer";

/**
 * `decodeUnresolvedArtifactImageText` is the exact inverse of the producer
 * `unresolvedArtifactImageText`, in one linear pass: it returns the image the
 * text is the fallback of, or `null`. Whether a text it accepts is read back as
 * exactly that image by the artifact readers is pinned in the gui-app
 * differential tests; these rows pin the decoder itself.
 */

const BS = "\\";

describe("decodeUnresolvedArtifactImageText: accepts", () => {
  it.each([
    ["a plain label", "![a](x)", { alt: "a", src: "x" }],
    ["an empty label", "![](x)", { alt: "", src: "x" }],
    ["a label with spaces", "![a b c](x)", { alt: "a b c", src: "x" }],
    ["a label with pipes", "![a | b](x)", { alt: "a | b", src: "x" }],
    [
      "a label with a backslash",
      `![a ${BS} b](x)`,
      { alt: `a ${BS} b`, src: "x" },
    ],
    ["a simple multiline label", "![a\nb](x)", { alt: "a\nb", src: "x" }],
    [
      "a bare destination with markdown characters",
      "![a](images/a_b*c.png)",
      {
        alt: "a",
        src: "images/a_b*c.png",
      },
    ],
    [
      "a bracketed destination",
      "![a](<images/a b.png>)",
      {
        alt: "a",
        src: "images/a b.png",
      },
    ],
    [
      "an escaped angle bracket in a destination",
      `![a](<images/a${BS}<b.png>)`,
      {
        alt: "a",
        src: "images/a<b.png",
      },
    ],
    [
      "an escaped backslash in a destination",
      `![a](<images/a${BS}${BS}b.png>)`,
      {
        alt: "a",
        src: `images/a${BS}b.png`,
      },
    ],
    [
      "an asterisk after a backslash in a source",
      `![a](<images/a${BS}${BS}*b.png>)`,
      {
        alt: "a",
        src: `images/a${BS}*b.png`,
      },
    ],
  ])("%s", (_name, text, expected) => {
    expect(decodeUnresolvedArtifactImageText(text)).toEqual(expected);
  });

  it.each([0, 1, 2, 3, 4, 5])("brackets at depth %i, escaped", (depth) => {
    const alt = `${"[".repeat(depth)}x${"]".repeat(depth)}`;
    const text = unresolvedArtifactImageText(alt, "x");
    expect(decodeUnresolvedArtifactImageText(text)).toEqual({ alt, src: "x" });
  });

  it.each([
    ["one backtick", "a `b` c"],
    ["two backticks", "a ``b`` c"],
    ["three backticks", "a ```b``` c"],
    ["a bracket inside a code span", "a `]` b"],
    ["a closing bracket between double backticks", "a ``]`` b"],
    ["a short run closing a longer span", "a ``b` c"],
  ])("a code span with %s", (_name, alt) => {
    // The producer escapes the brackets in the label, code span or not.
    const text = unresolvedArtifactImageText(alt, "x");
    expect(decodeUnresolvedArtifactImageText(text)).toEqual({ alt, src: "x" });
  });

  it("accepts an escaped bracket in the label", () => {
    expect(decodeUnresolvedArtifactImageText(`![a${BS}]b](x)`)).toEqual({
      alt: "a]b",
      src: "x",
    });
  });
});

describe("decodeUnresolvedArtifactImageText: rejects", () => {
  it.each([
    ["a carriage return", "![a\r\nb](x)"],
    ["a lone carriage return", "![a\rb](x)"],
    ["a NUL", "![a\u0000b](x)"],
    ["a trailing backslash", `![a${BS}](x)`],
    ["a backslash right before the closing bracket", `![a${BS}${BS}${BS}](x)`],
    ["a lone backtick", "![a`b](x)"],
    ["an unmatched backtick run", "![a ``b](x)"],
    ["an unescaped opening bracket", "![a [b] c](x)"],
    ["a later line that opens a heading", "![a\n# b](x)"],
    ["a later line that opens a list", "![a\n- b](x)"],
    ["a later line that opens an ordered list", "![a\n1. b](x)"],
    ["a blank later line", "![a\n\nb](x)"],
    ["a later line that starts with spaces", "![a\n  b](x)"],
    ["a later line after a line ending in a space", "![a \nb](x)"],
    ["a later line after a line ending in a tab", "![a\t\nb](x)"],
    ["an empty bracketed destination", "![a](<>)"],
    ["a bracketed destination of a bare source", "![a](<x>)"],
    ["a bare destination holding a space", "![a](x y)"],
    ["a bare destination holding a parenthesis", "![a](x(1).png)"],
    ["an unterminated bracketed destination", "![a](<x y)"],
    ["a newline in a bracketed destination", "![a](<x\ny>)"],
    ["an unescaped angle bracket in a bracketed destination", "![a](<x<y>)"],
    [
      "a backslash before a letter in a bracketed destination",
      `![a](<x${BS}y z>)`,
    ],
    ["text that is not an image", "a ![a](x)"],
    ["text after the image", "![a](x) tail"],
    ["a missing destination", "![a]"],
    ["a missing closing parenthesis", "![a](x"],
    ["an empty string", ""],
  ])("%s", (_name, text) => {
    expect(decodeUnresolvedArtifactImageText(text)).toBeNull();
  });
});

describe("decodeUnresolvedArtifactImageText: an alt the producer's text cannot carry", () => {
  it.each([
    ["a backslash before a bracket", `a${BS}]b`],
    ["a backslash before an opening bracket", `a${BS}[b`],
    ["a trailing backslash", `a${BS}`],
    ["a lone backtick", "a`b"],
    ["a carriage return", "a\rb"],
  ])("%s", (_name, alt) => {
    expect(
      decodeUnresolvedArtifactImageText(unresolvedArtifactImageText(alt, "x")),
    ).toBeNull();
  });
});

/**
 * The label lines after the first. The decoder accepts a later line unless it
 * would end the paragraph, turn it into another block, or be changed by the
 * paragraph (blank, leading whitespace, a previous line ending in whitespace).
 * The gui-app differential test pins, for each row below, what both artifact
 * readers do with the producer's text: every accept row is read back as that
 * exact image, and every reject row is one a reader does not read as one image
 * (or is listed there as conservative).
 */
const LATER_LINE_ACCEPTED: readonly string[] = [
  "[b]",
  `${BS}# b`,
  "*b*",
  "_b_",
  "+b",
  "-b",
  "=b",
  "|b|",
  "~b",
  "!b",
  "(b)",
  "&b",
  ":b",
  "`b`",
  "1.b",
  "#b",
  "####### b",
];

describe("decodeUnresolvedArtifactImageText: a later label line", () => {
  it.each(LATER_LINE_ACCEPTED.map((line) => [line] as const))(
    "accepts a later line %j",
    (line) => {
      const alt = `a\n${line}`;
      const text = unresolvedArtifactImageText(alt, "x");
      expect(decodeUnresolvedArtifactImageText(text)).toEqual({
        alt,
        src: "x",
      });
    },
  );

  it.each([
    ["an ATX heading", "# b"],
    ["a six-hash heading", "###### b"],
    ["a dash bullet", "- b"],
    ["a plus bullet", "+ b"],
    ["an asterisk bullet", "* b"],
    ["a lone dash", "-"],
    ["an ordered item at 1 with a dot", "1. b"],
    ["an ordered item at 1 with a parenthesis", "1) b"],
    ["an ordered item at 01", "01. b"],
    ["an ordered item at 2", "2. b"],
    ["an ordered item at 10 with a parenthesis", "10) b"],
    ["a quote", "> b"],
    ["a dash rule or setext underline", "---"],
    ["an equals setext underline", "==="],
    ["an asterisk rule", "***"],
    ["an underscore rule", "___"],
    ["a spaced rule", "- - -"],
    ["a table delimiter row of one column", "|-|"],
    ["an aligned delimiter cell", ":-:"],
    ["a spaced table delimiter row", "| --- |"],
    ["an HTML block", "<div>"],
    ["an HTML tag", "<b>"],
    ["a backtick fence", "```"],
    ["a tilde fence", "~~~"],
    ["a blank line", ""],
    ["a leading space", " b"],
  ])("rejects a later line that is %s", (_name, line) => {
    const text = unresolvedArtifactImageText(`a\n${line}`, "x");
    expect(decodeUnresolvedArtifactImageText(text)).toBeNull();
  });

  it("rejects a later line after a line ending in a space", () => {
    expect(
      decodeUnresolvedArtifactImageText(
        unresolvedArtifactImageText("a \nb", "x"),
      ),
    ).toBeNull();
  });

  it("rejects a blank line between two label lines", () => {
    expect(
      decodeUnresolvedArtifactImageText(
        unresolvedArtifactImageText("a\n\nb", "x"),
      ),
    ).toBeNull();
  });
});

describe("decodeUnresolvedArtifactImageText: the producer's round trip", () => {
  const ALPHABET = [
    "a",
    " ",
    BS,
    "[",
    "]",
    "`",
    "|",
    "\n",
    "\r",
    "<",
    ">",
    "(",
    ")",
    "*",
    "#",
    "-",
    "1",
    "&",
  ];
  const SRCS = [
    "images/x.png",
    "images/a b.png",
    "images/a(b).png",
    "images/a<b.png",
    "images/a>b.png",
    `images/a${BS}b.png`,
    `images/a${BS}*b.png`,
    `images/a${BS}_b.png`,
    "images/a&amp;b.png",
    "images/a%20b.png",
    "images/ b.png",
    "images/a\tb.png",
  ];

  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function alts(): string[] {
    const out: string[] = [""];
    let layer: string[] = [""];
    for (let length = 1; length <= 3; length++) {
      layer = layer.flatMap((prefix) => ALPHABET.map((char) => prefix + char));
      out.push(...layer);
    }
    for (let depth = 0; depth <= 5; depth++) {
      out.push(`${"[".repeat(depth)}x${"]".repeat(depth)}`);
    }
    const next = seeded(1563);
    for (let index = 0; index < 600; index++) {
      const length = 4 + Math.floor(next() * 9);
      let alt = "";
      for (let at = 0; at < length; at++) {
        alt += ALPHABET[Math.floor(next() * ALPHABET.length)];
      }
      out.push(alt);
    }
    return out;
  }

  it("decodes the producer's text to the same image, or to nothing - never to another image", () => {
    const all = alts();
    const next = seeded(7);
    let checked = 0;
    let accepted = 0;
    for (const alt of all) {
      // Every alt with a few of the sources; the first source for all of them.
      const picks = new Set([0]);
      while (picks.size < 3) picks.add(Math.floor(next() * SRCS.length));
      for (const pick of picks) {
        const src = SRCS[pick] ?? "";
        const decoded = decodeUnresolvedArtifactImageText(
          unresolvedArtifactImageText(alt, src),
        );
        checked++;
        if (decoded === null) continue;
        accepted++;
        expect(decoded).toEqual({ alt, src });
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(accepted).toBeGreaterThan(1000);
  });

  it("decodes every source with a plain label", () => {
    for (const src of SRCS) {
      expect(
        decodeUnresolvedArtifactImageText(
          unresolvedArtifactImageText("a", src),
        ),
      ).toEqual({ alt: "a", src });
    }
  });
});

describe("decodeUnresolvedArtifactImageText: linear time", () => {
  const time = (text: string): number => {
    const start = performance.now();
    decodeUnresolvedArtifactImageText(text);
    return performance.now() - start;
  };
  const SMALL = 256 * 1024;
  const LARGE = 1024 * 1024;
  // The best of a few runs, so one scheduling hiccup is not the measurement.
  const best = (text: string): number =>
    Math.min(time(text), time(text), time(text));

  function guard(small: string, large: string): void {
    const smallTime = best(small);
    const largeTime = best(large);
    expect(largeTime).toBeLessThan(2000);
    expect(largeTime).toBeLessThan(6 * smallTime + 50);
  }

  it("decodes a 1 MiB plain label", () => {
    const label = (size: number): string => `![${"a".repeat(size)}](x)`;
    guard(label(SMALL), label(LARGE));
  });

  it("decodes 1 MiB of alternating backticks", () => {
    const label = (size: number): string => `![${"` ".repeat(size / 2)}](x)`;
    guard(label(SMALL), label(LARGE));
  });

  it("decodes 1 MiB of backslashes and a 256 KiB code span", () => {
    const slashes = (size: number): string => `![${BS.repeat(size)}](x)`;
    guard(slashes(SMALL), slashes(LARGE));
    const span = `![\`${"a".repeat(SMALL)}\`](x)`;
    expect(best(span)).toBeLessThan(2000);
  });

  // Growth only, no ceiling: 4x the input may take about 4x the time, and a
  // quadratic scan takes about 16x, whatever the machine's speed.
  const SMALL_LINES = 16_000;
  const LARGE_LINES = 64_000;

  function grows(label: (size: number) => string): void {
    const text = (size: number): string =>
      unresolvedArtifactImageText(label(size), "images/x.png");
    const smallTime = best(text(SMALL_LINES));
    const largeTime = best(text(LARGE_LINES));
    expect(largeTime).toBeLessThan(6 * smallTime + 50);
  }

  it("rejects a later label line of dashes that ends in another character in linear time", () => {
    grows((size) => "a\n" + "-".repeat(size) + "x");
  });

  it("rejects a later label line of pipes and dashes that ends in another character in linear time", () => {
    // Pipes and colons alone fail at once on both forms (no rule character
    // for the required one), so the dashes are what the retries feed on.
    grows((size) => "a\n" + "|-".repeat(size / 2) + "x");
  });
});
