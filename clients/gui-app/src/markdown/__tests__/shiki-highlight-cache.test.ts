import { afterEach, describe, expect, it } from "vitest";
import {
  getCachedHighlight,
  HIGHLIGHT_CACHE_CHAR_BUDGET,
  highlightCacheSizeForTests,
  resetHighlightCacheForTests,
  setCachedHighlight,
} from "@/markdown/shiki-highlight-cache";

afterEach(() => {
  resetHighlightCacheForTests();
});

describe("shiki highlight MRU cache", () => {
  it("returns cached nodes by (theme, lang, code) and misses otherwise", () => {
    const node = "highlighted";
    setCachedHighlight("github-dark", "ts", "const a = 1;", {
      node,
      htmlChars: 64,
    });

    expect(getCachedHighlight("github-dark", "ts", "const a = 1;")).toBe(node);
    expect(getCachedHighlight("github-light", "ts", "const a = 1;")).toBe(
      undefined,
    );
    expect(getCachedHighlight("github-dark", "js", "const a = 1;")).toBe(
      undefined,
    );
    expect(getCachedHighlight("github-dark", "ts", "const a = 2;")).toBe(
      undefined,
    );
  });

  it("evicts least-recently-used entries once the html-char budget overflows", () => {
    // Two entries fit inside the budget; a third overflows by a few chars.
    // The budget is driven by the highlighted-HTML length, not the source.
    const third = Math.ceil(HIGHLIGHT_CACHE_CHAR_BUDGET / 3) + 1;
    setCachedHighlight("t", "ts", "code-1", {
      node: "first",
      htmlChars: third,
    });
    setCachedHighlight("t", "ts", "code-2", {
      node: "second",
      htmlChars: third,
    });

    // Touch the oldest entry so it becomes most-recently-used.
    expect(getCachedHighlight("t", "ts", "code-1")).toBe("first");

    // The third entry overflows the budget; the LRU entry is now the SECOND.
    setCachedHighlight("t", "ts", "code-3", {
      node: "third",
      htmlChars: third,
    });

    expect(getCachedHighlight("t", "ts", "code-2")).toBe(undefined);
    expect(getCachedHighlight("t", "ts", "code-1")).toBe("first");
    expect(getCachedHighlight("t", "ts", "code-3")).toBe("third");
  });

  it("skips entries larger than the whole budget instead of flushing the cache", () => {
    setCachedHighlight("t", "ts", "small", { node: "kept", htmlChars: 5 });
    setCachedHighlight("t", "ts", "huge", {
      node: "oversized",
      htmlChars: HIGHLIGHT_CACHE_CHAR_BUDGET + 1,
    });

    expect(highlightCacheSizeForTests()).toBe(1);
    expect(getCachedHighlight("t", "ts", "small")).toBe("kept");
  });

  it("replaces an existing key without double-counting its budget", () => {
    const big = HIGHLIGHT_CACHE_CHAR_BUDGET - 10;
    setCachedHighlight("t", "ts", "same-code", { node: "v1", htmlChars: big });
    setCachedHighlight("t", "ts", "same-code", { node: "v2", htmlChars: big });

    expect(highlightCacheSizeForTests()).toBe(1);
    expect(getCachedHighlight("t", "ts", "same-code")).toBe("v2");
  });
});
