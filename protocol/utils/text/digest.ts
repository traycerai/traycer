/**
 * A cheap, browser-safe content fingerprint for CHANGE DETECTION.
 *
 * Not a cryptographic digest and not a security boundary: nothing authenticates
 * on this, and a caller that needs collision resistance against an adversary
 * wants a real hash. What this answers is "did these bytes change since the
 * last time I looked", which is the question the transcript skeleton's diff
 * asks once per row per rebuild - so it has to be fast and allocation-light
 * far more than it has to be strong.
 *
 * ## Why two lanes
 *
 * One 32-bit FNV-1a lane would already make a missed change vanishingly
 * unlikely per row. It would also be the kind of number a reviewer has to do
 * arithmetic about, and the failure it admits is the silent one: a same-length
 * rewrite whose hash collides renders the OLD body forever, with nothing on
 * either side able to notice. Two decorrelated lanes cost one more multiply per
 * character and move that from "argued about" to "not a consideration".
 *
 * The lanes are decorrelated by using different offset bases AND different
 * multipliers - the same prime with a different seed would leave them running
 * the same recurrence, which is two views of one 32-bit hash rather than 64
 * bits of anything. The finish also folds in the total length, so a pure
 * transposition that happened to collide on both lanes still has to match on
 * size.
 */

/** FNV-1a's 32-bit offset basis and prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** A second basis/multiplier pair, from murmur3's mixing constants. */
const ALT_OFFSET_BASIS = 0xc2b2ae35;
const ALT_PRIME = 0x85ebca6b;

/**
 * A running fingerprint over a sequence of strings.
 *
 * Mutable and pushed into rather than a fold returning a new value, because the
 * callers feed it a row's records one JSON encoding at a time and concatenating
 * them first would allocate a copy of the row's whole body - which is the cost
 * the skeleton exists to avoid paying.
 */
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
 *
 * Order-sensitive by construction, which is what callers want: a row's records
 * are pushed in render order, so two rows holding the same records in a
 * different order are different bodies and must fingerprint differently.
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

/**
 * The fingerprint as a compact string.
 *
 * Base-36 because this rides EVERY entry of a skeleton that can be 20k rows
 * long, so the encoding's width is a wire cost paid per row: base-36 spends at
 * most 14 characters where hex would spend 16 and decimal 20.
 *
 * The low lane is zero-padded to its full 7-character width and the high lane
 * is not, so the two are unambiguous when read back as one string - an
 * unpadded pair would let `("1", "23")` and `("12", "3")` produce the same
 * digest, which is a collision manufactured by the encoding rather than by the
 * hash.
 */
export function finishContentFingerprint(state: ContentFingerprint): string {
  const low = (state.low ^ state.length) >>> 0;
  const high = (state.high + Math.imul(state.length, ALT_PRIME)) >>> 0;
  return `${high.toString(36)}${low.toString(36).padStart(7, "0")}`;
}
