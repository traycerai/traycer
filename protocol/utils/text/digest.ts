/** A cheap, browser-safe content fingerprint for CHANGE DETECTION. */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** A second basis/multiplier pair, from murmur3's mixing constants. */
const ALT_OFFSET_BASIS = 0xc2b2ae35;
const ALT_PRIME = 0x85ebca6b;

/** A running fingerprint over a sequence of strings. */
export interface ContentFingerprint {
  low: number;
  high: number;
  length: number;
}

export function startContentFingerprint(): ContentFingerprint {
  return { low: FNV_OFFSET_BASIS, high: ALT_OFFSET_BASIS, length: 0 };
}

/**
 * Absorb one chunk.
 * Order-sensitive by construction, which is what callers want: a row's records are pushed in render order, so two rows holding the same records in a different order are different bodies and must fingerprint differently.
 */
export function pushContentFingerprint(
  state: ContentFingerprint,
  value: string,
): void {
  let low = state.low;
  let high = state.high;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    low = Math.imul(low ^ code, FNV_PRIME);
    high = Math.imul(high ^ code, ALT_PRIME);
  }
  state.low = low;
  state.high = high;
  state.length += value.length;
}

/** The fingerprint as a compact string. */
export function finishContentFingerprint(state: ContentFingerprint): string {
  const low = (state.low ^ state.length) >>> 0;
  const high = (state.high + Math.imul(state.length, ALT_PRIME)) >>> 0;
  return `${high.toString(36)}${low.toString(36).padStart(7, "0")}`;
}
