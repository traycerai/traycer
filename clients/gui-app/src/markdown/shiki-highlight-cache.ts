import type { ReactNode } from "react";

/**
 * Global MRU cache for finished highlight renders.
 *
 * Values are the FINAL React nodes (post `codeToHtml` AND post
 * DOMPurify-sanitize + HTML→React parse), so a hit skips the entire per-block
 * pipeline - which matters because the sanitize+parse step is a meaningful
 * share of each highlight's cost. React elements are immutable descriptors,
 * so the same node tree can be rendered by any number of consumers.
 *
 * One module-level cache serves every markdown surface (chat tiles, plan
 * views, file previews): re-opening a warm chat re-paints its code blocks
 * without re-running shiki. Keyed by (theme, lang, code) so light/dark and
 * preset swaps never collide; old-theme entries age out via the budget.
 *
 * Bounded by total cached HIGHLIGHTED-HTML characters rather than entry
 * count - block sizes vary by ~1000x, so an entry cap would bound memory
 * poorly. The HTML length is what tracks the retained payload (the parsed
 * React tree is proportional to it), unlike the source length, which
 * undercounts span-heavy output by roughly an order of magnitude. Streaming
 * intermediates must never be written (they would churn the whole budget
 * every frame); callers cache only settled blocks.
 */
// Unit: post-highlight HTML characters. Shiki output runs roughly 10x its
// source, so this 20M-char budget retains about the same set of blocks as the
// previous 2M source-char budget (same order of magnitude of effective
// memory), while a giant pathological output can no longer be undercounted.
export const HIGHLIGHT_CACHE_CHAR_BUDGET = 20_000_000;

interface HighlightCacheEntry {
  readonly node: ReactNode;
  readonly chars: number;
}

// Map iteration order is insertion order; get() re-inserts to mark MRU, so
// the first key is always the least-recently-used entry.
const cache = new Map<string, HighlightCacheEntry>();
let totalChars = 0;

// NUL separators make the key unambiguous for any theme/lang. The key embeds
// a copy of `code` that is not counted against the (output-sized) budget -
// accepted, since a structured key would forfeit the single-Map
// insertion-order MRU above.
function cacheKey(theme: string, lang: string, code: string): string {
  return `${theme}\u0000${lang}\u0000${code}`;
}

export function getCachedHighlight(
  theme: string,
  lang: string,
  code: string,
): ReactNode | undefined {
  const key = cacheKey(theme, lang, code);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry.node;
}

export interface HighlightRender {
  readonly node: ReactNode;
  /**
   * Length of the highlighted HTML the `node` was parsed from - available
   * pre-parse, and the budget's accounting unit.
   */
  readonly htmlChars: number;
}

export function setCachedHighlight(
  theme: string,
  lang: string,
  code: string,
  render: HighlightRender,
): void {
  const { node, htmlChars } = render;
  // A single block larger than the whole budget would evict everything and
  // then exceed the bound anyway; just skip caching it.
  if (htmlChars > HIGHLIGHT_CACHE_CHAR_BUDGET) return;
  const key = cacheKey(theme, lang, code);
  const existing = cache.get(key);
  if (existing !== undefined) {
    cache.delete(key);
    totalChars -= existing.chars;
  }
  cache.set(key, { node, chars: htmlChars });
  totalChars += htmlChars;
  while (totalChars > HIGHLIGHT_CACHE_CHAR_BUDGET) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest !== undefined) totalChars -= oldest.chars;
  }
}

export function resetHighlightCacheForTests(): void {
  cache.clear();
  totalChars = 0;
}

export function highlightCacheSizeForTests(): number {
  return cache.size;
}
