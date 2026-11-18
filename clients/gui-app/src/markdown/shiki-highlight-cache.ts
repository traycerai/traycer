import type { ReactNode } from "react";
import { contentFingerprint } from "@/lib/text-hash";

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
 * without re-running shiki. Keyed by (theme, lang, hash-of-code) so light/dark
 * and preset swaps never collide; old-theme entries age out via the budget.
 *
 * Bounded by ESTIMATED RETAINED BYTES rather than by entry count or by output
 * characters. Block sizes vary by ~1000x, so an entry cap bounds memory
 * poorly - but counting highlighted-HTML characters was the deeper mistake:
 * what is retained is a parsed React element tree, not the HTML string it was
 * parsed from. Each shiki span becomes an element object plus a props object
 * plus a style object, so the live footprint runs roughly an order of
 * magnitude above the character count that used to be budgeted. The previous
 * 20M-character bound therefore admitted a cache measured in hundreds of
 * megabytes while reporting itself as bounded.
 *
 * Streaming intermediates must never be written (they would churn the whole
 * budget every frame); callers cache only settled blocks.
 */

/**
 * Bytes retained per character of highlighted HTML. A shiki span is roughly
 * `<span style="color:#RRGGBB">token</span>` - about 40 characters that parse
 * into an element object, a props object, a style object, and the token
 * string, landing near 300 bytes. That is ~8 bytes per character; 10 keeps a
 * margin without pretending to more precision than an estimate has.
 *
 * It is an estimate, and the safe direction is over-eviction: too high only
 * costs re-highlights, while too low re-creates the unbounded-cache bug.
 */
export const ESTIMATED_BYTES_PER_HTML_CHAR = 10;

/** ~6.4M characters of highlighted HTML at the factor above. */
// Sized so the byte budget does not quietly shrink the cache's working set:
// the previous character-count bound admitted ~20M highlighted-HTML chars,
// which at the estimate below is ~200 MB. Dropping straight to 64 MB cut
// capacity ~3x and would have traded a measured memory win for unmeasured
// re-highlight CPU on scrollback. 128 MB keeps most of the old working set
// while still bounding what the cache can retain.
export const HIGHLIGHT_CACHE_BYTE_BUDGET = 128 * 1024 * 1024;

export function estimatedHighlightBytes(htmlChars: number): number {
  return htmlChars * ESTIMATED_BYTES_PER_HTML_CHAR;
}

interface HighlightCacheEntry {
  readonly node: ReactNode;
  readonly bytes: number;
}

// Map iteration order is insertion order; get() re-inserts to mark MRU, so
// the first key is always the least-recently-used entry.
const cache = new Map<string, HighlightCacheEntry>();
let totalBytes = 0;

/**
 * NUL separators keep the key unambiguous for any theme/lang. The code itself
 * is hashed rather than embedded: keying by the source meant every cached
 * block also retained a full second copy of its own text, which the budget
 * never counted. A collision would render one block with another's
 * highlighting - cosmetic, and vanishingly unlikely at 106 bits plus an exact
 * length match.
 */
function cacheKey(theme: string, lang: string, code: string): string {
  return `${theme}\u0000${lang}\u0000${contentFingerprint(code)}`;
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
   * pre-parse, and what the retained-bytes estimate is derived from.
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
  const bytes = estimatedHighlightBytes(htmlChars);
  // A single block larger than the whole budget would evict everything and
  // then exceed the bound anyway; just skip caching it.
  if (bytes > HIGHLIGHT_CACHE_BYTE_BUDGET) return;
  const key = cacheKey(theme, lang, code);
  const existing = cache.get(key);
  if (existing !== undefined) {
    cache.delete(key);
    totalBytes -= existing.bytes;
  }
  cache.set(key, { node, bytes });
  totalBytes += bytes;
  while (totalBytes > HIGHLIGHT_CACHE_BYTE_BUDGET) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest !== undefined) totalBytes -= oldest.bytes;
  }
}

export function resetHighlightCacheForTests(): void {
  cache.clear();
  totalBytes = 0;
}

export function highlightCacheSizeForTests(): number {
  return cache.size;
}

export function highlightCacheBytesForTests(): number {
  return totalBytes;
}
