import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import { jsonContentToMarkdown } from "../json-content-serializer";

/**
 * Regression tests for inline mark serialization at text-node boundaries.
 *
 * A continuous mark that contains a nested mark splits into several
 * ProseMirror text nodes (`**bold `code` bold**` is three nodes). The
 * serializer used to wrap each node independently, emitting
 * `**bold **` + `` **`code`** `` + `** bold**` - the doubled `****` runs
 * re-parse as literal asterisks and corrupt every artifact whose content
 * nests marks. Delimiters must open and close only where the mark set
 * actually changes.
 */

function text(
  value: string,
  marks: { type: string; attrs?: Record<string, unknown> }[] | undefined,
): JsonContent {
  return marks
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function paragraphDoc(content: JsonContent[]): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content }],
  };
}

function toMarkdown(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
}

describe("inline mark serialization across text-node boundaries", () => {
  it("keeps a bold span continuous around nested inline code", () => {
    const doc = paragraphDoc([
      text("has ", undefined),
      text("no ", [{ type: "bold" }]),
      text("MergeProvenance", [{ type: "bold" }, { type: "code" }]),
      text(" table", [{ type: "bold" }]),
      text(" end", undefined),
    ]);

    expect(toMarkdown(doc)).toBe("has **no `MergeProvenance` table** end");
  });

  it("keeps a bold span continuous around a nested link", () => {
    const doc = paragraphDoc([
      text("see ", undefined),
      text("the ", [{ type: "bold" }]),
      text("docs", [
        { type: "bold" },
        { type: "link", attrs: { href: "http://example.com" } },
      ]),
      text(" here", [{ type: "bold" }]),
      text(" now", undefined),
    ]);

    expect(toMarkdown(doc)).toBe(
      "see **the [docs](http://example.com) here** now",
    );
  });

  it("handles deep nesting where mark order shifts with schema rank", () => {
    // ProseMirror sorts marks by schema rank, so the italic span's nodes
    // carry [italic], [bold, italic], [bold, code, italic] - the italic
    // mark changes position but the span is continuous.
    const doc = paragraphDoc([
      text("a ", [{ type: "italic" }]),
      text("b ", [{ type: "bold" }, { type: "italic" }]),
      text("c", [{ type: "bold" }, { type: "code" }, { type: "italic" }]),
      text(" d", [{ type: "bold" }, { type: "italic" }]),
      text(" e", [{ type: "italic" }]),
    ]);

    expect(toMarkdown(doc)).toBe("*a **b `c` d** e*");
  });

  it("keeps an inner mark open when an outer mark ends before it", () => {
    // `_**b** i_`: bold ends after "b" but italic continues. Continuation
    // ordering opens italic outermost, so bold closes without forcing an
    // italic close/reopen (which would double the delimiters).
    const doc = paragraphDoc([
      text("b", [{ type: "bold" }, { type: "italic" }]),
      text(" i", [{ type: "italic" }]),
    ]);

    expect(toMarkdown(doc)).toBe("***b** i*");
  });

  it("keeps a link continuous when a nested bold ends before it", () => {
    const doc = paragraphDoc([
      text("b", [
        { type: "bold" },
        { type: "link", attrs: { href: "http://example.com" } },
      ]),
      text(" i", [{ type: "link", attrs: { href: "http://example.com" } }]),
    ]);

    expect(toMarkdown(doc)).toBe("[**b** i](http://example.com)");
  });

  it("closes and reopens a code mark when a new mark starts inside it", () => {
    // Nothing may open inside inline code - markdown renders nested
    // delimiters literally - so the code mark closes and reopens innermost.
    const doc = paragraphDoc([
      text("a", [{ type: "code" }]),
      text("b", [{ type: "bold" }, { type: "code" }]),
    ]);

    expect(toMarkdown(doc)).toBe("`a`**`b`**");
  });

  it("still delimits adjacent spans separated by plain text", () => {
    const doc = paragraphDoc([
      text("a ", undefined),
      text("x", [{ type: "code" }]),
      text(" b ", undefined),
      text("y", [{ type: "code" }]),
      text(" c", undefined),
    ]);

    expect(toMarkdown(doc)).toBe("a `x` b `y` c");
  });

  it("splits adjacent links with different targets", () => {
    const doc = paragraphDoc([
      text("one", [{ type: "link", attrs: { href: "http://a.example" } }]),
      text("two", [{ type: "link", attrs: { href: "http://b.example" } }]),
    ]);

    expect(toMarkdown(doc)).toBe(
      "[one](http://a.example)[two](http://b.example)",
    );
  });

  it("closes open marks before non-text inline nodes", () => {
    const doc = paragraphDoc([
      text("start ", [{ type: "bold" }]),
      {
        type: "mention",
        attrs: {
          contextType: "file",
          id: "src/app.ts",
          relPath: "src/app.ts",
        },
      },
      text(" finish", [{ type: "bold" }]),
    ]);

    expect(toMarkdown(doc)).toBe("**start **@src/app.ts** finish**");
  });

  it("renders links without an href as plain text", () => {
    const doc = paragraphDoc([
      text("plain", [{ type: "link", attrs: {} }]),
      text(" after", undefined),
    ]);

    expect(toMarkdown(doc)).toBe("plain after");
  });

  it("round-trips a paragraph shaped like the corrupted artifact", () => {
    const doc = paragraphDoc([
      text("Therefore ", undefined),
      text("container.isBound(TOKENS.MergeProvenanceService)", [
        { type: "code" },
      ]),
      text(" at ", undefined),
      text("runtime.ts:220", [{ type: "code" }]),
      text(" is ", undefined),
      text("always false", [{ type: "bold" }]),
      text(" in production → ", undefined),
      text("mergeProvenanceService = null", [{ type: "code" }]),
      text(".", undefined),
    ]);

    expect(toMarkdown(doc)).toBe(
      "Therefore `container.isBound(TOKENS.MergeProvenanceService)` at `runtime.ts:220` is **always false** in production → `mergeProvenanceService = null`.",
    );
  });
});
