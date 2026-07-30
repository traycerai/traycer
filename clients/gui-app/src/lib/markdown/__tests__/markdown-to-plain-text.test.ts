import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "@/lib/markdown/markdown-to-plain-text";

describe("markdownToPlainText", () => {
  it("drops heading markers and keeps the heading text", () => {
    expect(markdownToPlainText("## Heading")).toBe("Heading");
    expect(markdownToPlainText("# A\n\n### B")).toBe("A · B");
  });

  it("keeps a link label and drops its URL", () => {
    expect(markdownToPlainText("see [docs](https://example.com/a/b)")).toBe(
      "see docs",
    );
  });

  it("keeps emphasis text without the markers", () => {
    expect(markdownToPlainText("some **bold** and _thin_ text")).toBe(
      "some bold and thin text",
    );
  });

  it("summarises a mermaid fence rather than previewing its syntax", () => {
    const plain = markdownToPlainText("```mermaid\ngraph TD;\n  A-->B;\n```");
    expect(plain).toBe("Diagram");
    expect(plain).not.toContain("graph");
    expect(plain).not.toContain("`");
  });

  it("summarises any other fence as Code", () => {
    expect(markdownToPlainText("```ts\nconst x = 1;\n```")).toBe("Code");
    // Indented code has no language and is still a fence to the reader.
    expect(markdownToPlainText("    const x = 1;")).toBe("Code");
  });

  it("keeps inline code text, which is prose the reader sees", () => {
    expect(markdownToPlainText("run `bun test` first")).toBe(
      "run bun test first",
    );
  });

  it("flattens a list into separated items", () => {
    expect(markdownToPlainText("- one\n- two")).toBe("one · two");
  });

  it("keeps image alt text and drops the source", () => {
    expect(markdownToPlainText("![a diagram](./x.png)")).toBe("a diagram");
  });

  it("drops raw HTML entirely", () => {
    expect(markdownToPlainText("<div>hi</div>\n\nafter")).toBe("after");
  });

  it("reads table cells as text", () => {
    const plain = markdownToPlainText("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(plain).toContain("a");
    expect(plain).toContain("2");
    expect(plain).not.toContain("|");
  });

  it("does not treat a literal asterisk as emphasis", () => {
    // The whole reason this is a parse and not a regex strip.
    expect(markdownToPlainText("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("returns the same projection for repeated input", () => {
    const source = "## Cached\n\nbody";
    expect(markdownToPlainText(source)).toBe(markdownToPlainText(source));
  });

  it("is empty for empty input", () => {
    expect(markdownToPlainText("")).toBe("");
  });
});

/**
 * The lexer leaves character references encoded in `text` tokens, but the
 * expanded body decodes them downstream - so without this a row's preview and
 * its own expansion disagree about what the message says.
 */
describe("markdownToPlainText character references", () => {
  it("decodes the named references that actually show up in prose", () => {
    expect(markdownToPlainText("R&amp;D uses &lt;alpha&gt;")).toBe(
      "R&D uses <alpha>",
    );
    expect(markdownToPlainText("&quot;quoted&quot;")).toBe('"quoted"');
    expect(markdownToPlainText("it&apos;s fine")).toBe("it's fine");
  });

  it("decodes decimal and hexadecimal numeric references", () => {
    expect(markdownToPlainText("&#39;q&#39;")).toBe("'q'");
    expect(markdownToPlainText("a &#x26; b")).toBe("a & b");
    // Astral plane, so `String.fromCharCode` would have been wrong here.
    expect(markdownToPlainText("&#x1F600;")).toBe("\u{1F600}");
  });

  it("decodes inside a heading", () => {
    expect(markdownToPlainText("## R&amp;D notes")).toBe("R&D notes");
  });

  it("decodes inside a link label, still without the URL", () => {
    const plain = markdownToPlainText("[R&amp;D](https://example.com/x)");
    expect(plain).toBe("R&D");
  });

  it("decodes inside image alt text", () => {
    expect(markdownToPlainText("![a &lt;b&gt; chart](x.png)")).toBe(
      "a <b> chart",
    );
  });

  it("leaves a reference inside inline code LITERAL", () => {
    // CommonMark treats character references in a code span as text, and the
    // rendered body shows `&amp;` there too - decoding would disagree with it.
    expect(markdownToPlainText("use `&amp;` here")).toBe("use &amp; here");
    expect(markdownToPlainText("`a &lt; b`")).toBe("a &lt; b");
  });

  it("decodes in ONE pass, so a doubly-encoded reference stays encoded", () => {
    // `&amp;lt;` is the way an author writes the literal text `&lt;`. Chained
    // replaces would turn it into `<` and rewrite what they said.
    expect(markdownToPlainText("a &amp;lt; b")).toBe("a &lt; b");
  });

  it("leaves an unknown or malformed reference exactly as written", () => {
    expect(markdownToPlainText("&unknownent; stays")).toBe(
      "&unknownent; stays",
    );
    expect(markdownToPlainText("bare & ampersand")).toBe("bare & ampersand");
    // Out of Unicode range, and a lone surrogate: not characters.
    expect(markdownToPlainText("&#x110000;")).toBe("&#x110000;");
    expect(markdownToPlainText("&#xD800;")).toBe("&#xD800;");
  });
});
