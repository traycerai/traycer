/**
 * Byte ownership across the worker boundary: transfer, never share.
 * A `Uint8Array` in this codebase is very often a view over a larger buffer (`subarray` slices out of a decode buffer, `Y.encodeStateVector` results, anything a reader hands back without copying).
 */

/**
 * A byte payload prepared for `postMessage`, together with the transfer list that must accompany it.
 * Post `bytes`, not the value you passed in: on the copy path they are different objects, and posting the original would send the wrong window.
 */
export interface TransferableBytes {
  readonly bytes: Uint8Array;
  readonly transfer: readonly ArrayBuffer[];
}

/**
 * Prepares `bytes` to cross the boundary by transfer where that is sound, and by copy where it is not.
 * The receiver observes exactly `[byteOffset, byteOffset + byteLength)` in both cases - identical bytes, identical length - so the choice is invisible to the protocol and visible only in cost.
 */
export function takeBytesForTransfer(bytes: Uint8Array): TransferableBytes {
  const buffer = bytes.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return { bytes, transfer: [buffer] };
  }
  const owned = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(owned);
  copy.set(bytes);
  return { bytes: copy, transfer: [owned] };
}

export function mergeTransferLists(
  parts: readonly TransferableBytes[],
): readonly ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  for (const part of parts) {
    for (const buffer of part.transfer) {
      seen.add(buffer);
    }
  }
  return [...seen];
}

export const NO_TRANSFER: readonly ArrayBuffer[] = Object.freeze([]);
