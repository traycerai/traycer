import { renderHook } from "@testing-library/react";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import {
  lexMarkdownBlocks,
  useMarkdownBlocks,
} from "@/markdown/use-markdown-blocks";
import { repairMarkdown } from "@/markdown/markdown-repair";

/** Full-lex reference: a freshly-mounted hook always takes the non-incremental path. */
function rawsFresh(content: string): string[] {
  const { result, unmount } = renderHook(() => useMarkdownBlocks(content));
  const raws = result.current.blocks.map((block) => block.raw);
  unmount();
  return raws;
}

/** The canonical block split: a single full lex of the repaired content. */
function fullLexRaws(content: string): string[] {
  const repaired = repairMarkdown(content);
  if (!repaired.trim()) return [];
  return marked
    .lexer(repaired)
    .flatMap((token) => (token.type === "space" ? [] : [token.raw]));
}

function expectedTailStartIndex(content: string): number {
  const repaired = repairMarkdown(content);
  if (!repaired.trim()) return 0;
  const tokens = marked.lexer(repaired).map((token) => ({
    type: token.type,
    raw: token.raw,
  }));
  for (let index = tokens.length - 1; index >= 1; index -= 1) {
    if (tokens[index]?.type === "space" && tokens[index - 1]?.type !== "list") {
      return index + 1;
    }
  }
  return 0;
}

/**
 * Stream `content` one character at a time through the pure incremental lexer,
 * threading its cache, and assert the blocks match a one-shot full lex at EVERY
 * prefix. This is the property the cache must preserve.
 */
function expectStreamMatchesFullLex(content: string): void {
  let cache = null;
  for (let end = 1; end <= content.length; end += 1) {
    const prefix = content.slice(0, end);
    const result = lexMarkdownBlocks(cache, prefix);
    cache = result.cache;
    expect(result.blocks.map((block) => block.raw)).toEqual(
      fullLexRaws(prefix),
    );
  }
}

// Covers the tricky streaming cases: a heading, a paragraph, a list that grows
// item-by-item, and a code fence that is unterminated for several frames before
// it closes (exercising the repair-driven tail re-lex + stable-prefix guard).
const DOC = [
  "# Title\n\n",
  "First paragraph with some text.\n\n",
  "- item one\n- item two\n\n",
  "```ts\nconst x = 1;\nconst y = 2;\n```\n\n",
  "Closing paragraph here.",
].join("");

describe("useMarkdownBlocks", () => {
  it("yields the same blocks as a full lex at every streamed prefix", () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) => useMarkdownBlocks(content),
      { initialProps: { content: "" } },
    );

    for (let end = 1; end <= DOC.length; end += 1) {
      const prefix = DOC.slice(0, end);
      rerender({ content: prefix });
      const incremental = result.current.blocks.map((block) => block.raw);
      expect(incremental).toEqual(rawsFresh(prefix));
    }
  });

  it("keeps closed-block raw strings referentially stable as the tail grows", () => {
    const stepA = "# Title\n\nFirst paragraph.\n\nSecond para";
    const stepB = `${stepA}graph continues.\n\nThird`;
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) => useMarkdownBlocks(content),
      { initialProps: { content: stepA } },
    );
    const firstHeadingRaw = result.current.blocks[0]?.raw;

    rerender({ content: stepB });
    // The closed heading block's `raw` is the identical string instance reused
    // from the cache, so the downstream `MarkdownBlock` memo holds.
    expect(result.current.blocks[0]?.raw).toBe(firstHeadingRaw);
  });

  it("falls back to a full lex when content is edited rather than appended", () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) => useMarkdownBlocks(content),
      { initialProps: { content: DOC } },
    );
    const edited = DOC.replace("First paragraph", "Edited paragraph");
    rerender({ content: edited });
    expect(result.current.blocks.map((block) => block.raw)).toEqual(
      rawsFresh(edited),
    );
  });

  it("returns no blocks for blank content", () => {
    const { result } = renderHook(() => useMarkdownBlocks("   \n  "));
    expect(result.current).toEqual({ blocks: [], tailStartIndex: 0 });
  });

  it("exposes the frozen-prefix boundary for a streaming append", () => {
    const content = "# Title\n\nFirst paragraph.\n\nTail still open";
    const { result } = renderHook(() => useMarkdownBlocks(content));

    expect(result.current.tailStartIndex).toBe(expectedTailStartIndex(content));
    expect(result.current.blocks[0]?.id).toBeLessThan(
      result.current.tailStartIndex,
    );
    expect(result.current.blocks.at(-1)?.id).toBeGreaterThanOrEqual(
      result.current.tailStartIndex,
    );
  });

  it("moves the exposed boundary for a reshaping streaming case", () => {
    const beforeSetext = "# H\n\nSome paragraph\n\nSetext Heading";
    const afterSetext = `${beforeSetext}\n===\n\nmore`;
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) => useMarkdownBlocks(content),
      { initialProps: { content: beforeSetext } },
    );

    expect(result.current.tailStartIndex).toBe(
      expectedTailStartIndex(beforeSetext),
    );

    rerender({ content: afterSetext });

    expect(result.current.tailStartIndex).toBe(
      expectedTailStartIndex(afterSetext),
    );
    expect(result.current.blocks.map((block) => block.raw)).toEqual(
      fullLexRaws(afterSetext),
    );
  });
});

describe("lexMarkdownBlocks streaming equivalence", () => {
  // Each case streams char-by-char and must match a one-shot full lex at every
  // prefix. The list/setext/lazy-continuation cases all diverged under the
  // previous "freeze every token but the last" cache - block tokenization is
  // NOT fully local, so a closed-looking block could still be reshaped by
  // appended text.
  const CASES: ReadonlyArray<{ name: string; content: string }> = [
    { name: "loose unordered list", content: "- one\n- two\n\n- three\n\nend" },
    { name: "loose ordered list", content: "1. a\n2. b\n\n3. c\n\nend" },
    {
      name: "ordered list with a transient bare marker",
      content: "1. first\n2. second\n\n3\n\n4. fourth\n\ntail",
    },
    {
      name: "nested list",
      content: "- top\n  - nested one\n  - nested two\n- top two\n\nend",
    },
    {
      name: "list then paragraph then a separate list",
      content: "- a\n- b\n\nreal paragraph here\n\n- c\n- d\n\nx",
    },
    {
      name: "setext heading forming from a paragraph",
      content: "# H\n\nSome paragraph\n\nSetext Heading\n===\n\nmore",
    },
    {
      name: "lazy paragraph continuation then a list",
      content: "para words here\n| - | - |\n- b\ntext\n\nfin",
    },
    {
      name: "heading then indented continuation",
      content: "## Heading\n\nintro\n\n## Next\n   indented tail\n\nend",
    },
    {
      name: "duplicate link reference definitions",
      content: "## H\n\n[r]: http://x\n\nuse [r]\n\n[r]: http://y\n\nend",
    },
    {
      name: "blockquotes separated by blank lines",
      content: "> quote one\n\n> quote two\n\nafter the quotes",
    },
    {
      name: "table growing a row at a time",
      content: "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nafter",
    },
    { name: "the heading + list + fence doc", content: DOC },
  ];

  for (const { name, content } of CASES) {
    it(name, () => {
      expectStreamMatchesFullLex(content);
    });
  }

  it("re-lexes only the open tail once a blank-line boundary is established", () => {
    const head = "# Title\n\nFirst settled paragraph.\n\n";
    const a = lexMarkdownBlocks(null, `${head}Second para`);
    const b = lexMarkdownBlocks(a.cache, `${head}Second paragraph grows here.`);
    // The settled prefix blocks are reused verbatim (same string instances).
    expect(b.blocks[0]?.raw).toBe(a.blocks[0]?.raw);
    expect(b.blocks[1]?.raw).toBe(a.blocks[1]?.raw);
    expect(b.blocks.map((block) => block.raw)).toEqual(
      fullLexRaws(`${head}Second paragraph grows here.`),
    );
  });
});
