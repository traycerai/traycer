import type { ReactNode } from "react";
import { contentFingerprint } from "@/lib/text-hash";

/** Global MRU of finished highlight React nodes. Bounded by estimated retained bytes, not entry count or HTML characters. Never cache streaming intermediates. */

/** Estimated bytes retained per highlighted-HTML character. Over-eviction is safer than under-eviction. */
export const ESTIMATED_BYTES_PER_HTML_CHAR = 10;

/** ~6.4M characters of highlighted HTML at the factor above. */
// 128 MB: a 64 MB cap cut capacity ~3x and traded memory for re-highlight CPU
// on scrollback.
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

/** Hash the source rather than embed it; a source-keyed cache retained a second uncounted copy of every block. */
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
  /** Length of the highlighted HTML the `node` was parsed from - available pre-parse, and what the retained-bytes estimate is derived from. */
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
