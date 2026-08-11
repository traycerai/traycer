/**
 * Content fingerprints for caches that must key on large strings without
 * retaining them.
 *
 * Both callers here (the shiki highlight cache, the accumulated-changes diff
 * counter) sit in front of work that is far more expensive than a linear pass
 * over the source, and both are fed fresh string instances on every frame - so
 * identity comparison is useless and embedding the source in the key would
 * double its retained size.
 */

/**
 * 53-bit string hash (cyrb53).
 */
export function hash53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Two independently seeded hashes plus the exact length: ~106 bits of
 * discrimination, and no reference to `text` survives in the result.
 */
export function contentFingerprint(text: string): string {
  const low = hash53(text, 0).toString(36);
  const high = hash53(text, 1).toString(36);
  return `${text.length} ${low} ${high}`;
}
