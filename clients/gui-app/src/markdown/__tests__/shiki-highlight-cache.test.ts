import { afterEach, describe, expect, it } from "vitest";
import {
  estimatedHighlightBytes,
  getCachedHighlight,
  HIGHLIGHT_CACHE_BYTE_BUDGET,
  highlightCacheByteBudget,
  highlightCacheBytesForTests,
  highlightCacheSizeForTests,
  resetHighlightCacheForTests,
  setCachedHighlight,
} from "@/markdown/shiki-highlight-cache";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

/** Highlighted-HTML length whose estimated retained bytes are `fraction` of
 * the budget - the tests think in the budget's own unit rather than hardcoding
 * the conversion factor. */
function htmlCharsForBudgetFraction(fraction: number): number {
  const bytes = HIGHLIGHT_CACHE_BYTE_BUDGET * fraction;
  return Math.ceil(bytes / estimatedHighlightBytes(1));
}

afterEach(() => {
  resetHighlightCacheForTests();
  // The profile is a module singleton; leaving it switched would shrink the
  // budget under every later suite in this file.
  setRetentionProfile(DESKTOP_RETENTION_PROFILE);
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

  it("distinguishes sources that differ only late in a long block", () => {
    // The key hashes the source rather than embedding it, so near-identical
    // long blocks are the case that would expose a weak hash.
    const base = "const value = 1;\n".repeat(2000);
    setCachedHighlight("t", "ts", `${base}// a`, { node: "a", htmlChars: 64 });
    setCachedHighlight("t", "ts", `${base}// b`, { node: "b", htmlChars: 64 });

    expect(highlightCacheSizeForTests()).toBe(2);
    expect(getCachedHighlight("t", "ts", `${base}// a`)).toBe("a");
    expect(getCachedHighlight("t", "ts", `${base}// b`)).toBe("b");
  });

  it("evicts least-recently-used entries once the retained-byte budget overflows", () => {
    // Two entries fit inside the budget; a third overflows it.
    const third = htmlCharsForBudgetFraction(1 / 3) + 1;
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

  it("budgets by estimated retained bytes, not by html characters", () => {
    const htmlChars = 1_000;
    setCachedHighlight("t", "ts", "sized", { node: "n", htmlChars });

    // The retained React tree is an order of magnitude above the HTML length;
    // budgeting by the character count is what let the cache grow unbounded.
    expect(highlightCacheBytesForTests()).toBe(
      estimatedHighlightBytes(htmlChars),
    );
    expect(highlightCacheBytesForTests()).toBeGreaterThan(htmlChars);
  });

  it("skips entries larger than the whole budget instead of flushing the cache", () => {
    setCachedHighlight("t", "ts", "small", { node: "kept", htmlChars: 5 });
    setCachedHighlight("t", "ts", "huge", {
      node: "oversized",
      htmlChars: htmlCharsForBudgetFraction(1) + 1,
    });

    expect(highlightCacheSizeForTests()).toBe(1);
    expect(getCachedHighlight("t", "ts", "small")).toBe("kept");
  });

  it("takes its budget from the active retention profile", () => {
    expect(highlightCacheByteBudget()).toBe(HIGHLIGHT_CACHE_BYTE_BUDGET);
    expect(HIGHLIGHT_CACHE_BYTE_BUDGET).toBe(
      DESKTOP_RETENTION_PROFILE.highlightCacheBytes,
    );

    setRetentionProfile(MOBILE_RETENTION_PROFILE);

    expect(highlightCacheByteBudget()).toBe(
      MOBILE_RETENTION_PROFILE.highlightCacheBytes,
    );
    expect(highlightCacheByteBudget()).toBeLessThan(
      HIGHLIGHT_CACHE_BYTE_BUDGET,
    );
  });

  it("evicts against the mobile budget once the phone's profile is active", () => {
    // Sized to fit desktop comfortably and to overflow mobile on its own: the
    // phone must not retain a working set picked for a 4 GB renderer.
    const htmlChars = htmlCharsForBudgetFraction(1 / 2);
    setCachedHighlight("t", "ts", "desktop-sized", {
      node: "kept",
      htmlChars,
    });
    expect(highlightCacheSizeForTests()).toBe(1);

    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    resetHighlightCacheForTests();

    // Larger than the whole mobile budget, so it is skipped outright rather
    // than admitted and then evicting everything behind it.
    setCachedHighlight("t", "ts", "desktop-sized", {
      node: "too big for the phone",
      htmlChars,
    });
    expect(highlightCacheSizeForTests()).toBe(0);

    // What the phone does keep is bounded by its own budget, not desktop's.
    const mobileSized = Math.ceil(
      MOBILE_RETENTION_PROFILE.highlightCacheBytes /
        (2 * estimatedHighlightBytes(1)),
    );
    setCachedHighlight("t", "ts", "phone-a", {
      node: "a",
      htmlChars: mobileSized,
    });
    setCachedHighlight("t", "ts", "phone-b", {
      node: "b",
      htmlChars: mobileSized,
    });
    setCachedHighlight("t", "ts", "phone-c", {
      node: "c",
      htmlChars: mobileSized,
    });

    expect(highlightCacheBytesForTests()).toBeLessThanOrEqual(
      MOBILE_RETENTION_PROFILE.highlightCacheBytes,
    );
    expect(getCachedHighlight("t", "ts", "phone-a")).toBe(undefined);
    expect(getCachedHighlight("t", "ts", "phone-c")).toBe("c");
  });

  it("replaces an existing key without double-counting its budget", () => {
    const big = htmlCharsForBudgetFraction(1) - 10;
    setCachedHighlight("t", "ts", "same-code", { node: "v1", htmlChars: big });
    setCachedHighlight("t", "ts", "same-code", { node: "v2", htmlChars: big });

    expect(highlightCacheSizeForTests()).toBe(1);
    expect(getCachedHighlight("t", "ts", "same-code")).toBe("v2");
  });
});
