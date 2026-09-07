/**
 * Byte ownership across the worker boundary: transfer, never share.
 *
 * The runtime moves into a dedicated Web Worker, and every byte payload that
 * crosses (encoded doc updates, state vectors, attachment bytes) is large
 * enough that a structured-clone COPY is the cost the relocation exists to
 * avoid. `postMessage`'s transfer list moves the backing `ArrayBuffer` instead
 * - O(1), no copy - at the price of detaching it on the sending side.
 *
 * That price is where the bug lives, and it is not hypothetical. A
 * `Uint8Array` in this codebase is very often a VIEW over a larger buffer
 * (`subarray` slices out of a decode buffer, `Y.encodeStateVector` results,
 * anything a reader hands back without copying). Transferring `view.buffer`
 * for such a view does two wrong things at once:
 *
 *   1. it hands the receiver the WHOLE buffer's memory, of which the payload
 *      is one window - the other windows are somebody else's bytes; and
 *   2. it detaches every SIBLING view over that buffer on the sending side,
 *      which then silently reads as zero-length rather than throwing.
 *
 * Demonstrated, not assumed: for an 8-byte buffer with a 3-byte view over
 * `[2,5)`, `structuredClone(view, { transfer: [view.buffer] })` delivers the
 * correct 3 bytes AND leaves the sender's full-buffer view at
 * `byteLength === 0`. The receiver looks right, so nothing at the boundary
 * reports the loss; it surfaces later, somewhere else, as empty bytes.
 *
 * So the rule this module enforces is: a payload is transferred only when it
 * owns its entire buffer, and is otherwise COPIED into a buffer it does own.
 * The copy is the honest cost of a partial view - paying it is strictly better
 * than transferring memory the payload does not own.
 *
 * `SharedArrayBuffer` is excluded by the same test. Sharing is deliberately
 * not part of this design: two threads mutating one replica's bytes has no
 * story for the projection kernel's transaction boundaries, and a `SAB` is not
 * transferable anyway (it clones by reference, which is precisely the aliasing
 * this boundary exists to prevent).
 */

/**
 * A byte payload prepared for `postMessage`, together with the transfer list
 * that must accompany it.
 *
 * Post `bytes`, not the value you passed in: on the copy path they are
 * different objects, and posting the original would send the wrong window.
 * After the post, treat the value you passed in as CONSUMED on both paths -
 * on the transfer path it is genuinely detached, and a caller that reads it
 * anyway would be relying on which path it happened to take.
 */
export interface TransferableBytes {
  readonly bytes: Uint8Array;
  readonly transfer: readonly ArrayBuffer[];
}

/**
 * Prepares `bytes` to cross the boundary by transfer where that is sound, and
 * by copy where it is not.
 *
 * The receiver observes exactly `[byteOffset, byteOffset + byteLength)` in
 * both cases - identical bytes, identical length - so the choice is invisible
 * to the protocol and visible only in cost.
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

/**
 * Flattens several prepared payloads into one transfer list, with duplicates
 * removed.
 *
 * The de-duplication is load-bearing rather than tidy: `postMessage` throws
 * `DataCloneError` when the same `ArrayBuffer` appears twice in a transfer
 * list, and a message carrying the same byte payload under two fields (an
 * update echoed back beside its own state vector, say) is an ordinary thing to
 * build. A throw at the boundary loses the whole message, not one field.
 */
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

/**
 * The empty transfer list, for messages that carry no bytes.
 *
 * A shared frozen constant rather than a fresh `[]` per call: every `emit` on
 * the bridge passes one, and the endpoint's signature requires it explicitly -
 * there is no defaulted parameter to hide the question of whether a message
 * owns bytes.
 */
export const NO_TRANSFER: readonly ArrayBuffer[] = Object.freeze([]);
