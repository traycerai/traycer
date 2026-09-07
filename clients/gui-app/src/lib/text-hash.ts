/** Content fingerprints for caches that must key on large strings without retaining them. */

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
 * Two independently seeded hashes plus the exact length: ~106 bits of discrimination, and no reference to `text` survives in the result.
 */
export function contentFingerprint(text: string): string {
  const low = hash53(text, 0).toString(36);
  const high = hash53(text, 1).toString(36);
  return `${text.length} ${low} ${high}`;
}
