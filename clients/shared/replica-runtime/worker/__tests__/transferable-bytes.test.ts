/**
 * Transfer semantics, driven through the REAL platform primitive.
 *
 * Every assertion here goes through `structuredClone(value, { transfer })`,
 * which is the same machinery `postMessage` uses. That matters: the property
 * under test is what the RUNTIME does with a transfer list, not what this
 * module believes it does, and a suite that only inspected the returned list
 * would agree with a helper that transfers the wrong buffer.
 */
import { describe, expect, it } from "vitest";
import {
  mergeTransferLists,
  NO_TRANSFER,
  takeBytesForTransfer,
} from "../transferable-bytes";

/** Sends bytes the way the bridge does, and answers what the receiver sees. */
function deliver(
  bytes: Uint8Array,
  transfer: readonly ArrayBuffer[],
): Uint8Array {
  return structuredClone(bytes, { transfer: [...transfer] });
}

describe("takeBytesForTransfer", () => {
  it("transfers the buffer when the payload owns all of it", () => {
    const buffer = new ArrayBuffer(4);
    const bytes = new Uint8Array(buffer);
    bytes.set([9, 8, 7, 6]);

    const prepared = takeBytesForTransfer(bytes);

    // Zero-copy: the payload's own buffer is what moves.
    expect(prepared.transfer).toEqual([buffer]);
    expect(prepared.bytes).toBe(bytes);
    expect([...deliver(prepared.bytes, prepared.transfer)]).toEqual([
      9, 8, 7, 6,
    ]);
    // ...and the sender's buffer is now detached, which is the cost that makes
    // it zero-copy.
    expect(buffer.byteLength).toBe(0);
  });

  it("copies a partial view, so the receiver gets the window and nothing else", () => {
    const buffer = new ArrayBuffer(8);
    const whole = new Uint8Array(buffer);
    whole.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const window = whole.subarray(2, 5);

    const prepared = takeBytesForTransfer(window);
    const received = deliver(prepared.bytes, prepared.transfer);

    expect([...received]).toEqual([3, 4, 5]);
    // The whole point: transferring `window.buffer` would have handed over all
    // eight bytes AND detached `whole` on this side. Both survive.
    expect(prepared.transfer).not.toContain(buffer);
    expect(buffer.byteLength).toBe(8);
    expect([...whole]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("copies a view that starts at zero but stops short of the buffer's end", () => {
    // The near-miss of the case above, and the one an offset-only check
    // would let through: `byteOffset === 0` yet the view is not the buffer.
    const buffer = new ArrayBuffer(8);
    const whole = new Uint8Array(buffer);
    whole.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const head = new Uint8Array(buffer, 0, 3);

    const prepared = takeBytesForTransfer(head);
    const received = deliver(prepared.bytes, prepared.transfer);

    expect([...received]).toEqual([1, 2, 3]);
    expect(buffer.byteLength).toBe(8);
    expect([...whole]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("delivers an empty payload without transferring a foreign buffer", () => {
    const buffer = new ArrayBuffer(4);
    const empty = new Uint8Array(buffer, 2, 0);

    const prepared = takeBytesForTransfer(empty);

    expect([...deliver(prepared.bytes, prepared.transfer)]).toEqual([]);
    expect(buffer.byteLength).toBe(4);
  });
});

describe("mergeTransferLists", () => {
  it("de-duplicates, because a repeated buffer makes the whole post throw", () => {
    const buffer = new ArrayBuffer(4);
    const bytes = new Uint8Array(buffer);
    const once = takeBytesForTransfer(bytes);
    // The same payload referenced twice in one frame - an update echoed beside
    // its own state vector, say.
    const merged = mergeTransferLists([once, once]);

    expect(merged).toEqual([buffer]);
    // Proof the de-duplication is load-bearing rather than tidy: the naive
    // list is a hard failure at the boundary, not a slower post.
    expect(() =>
      structuredClone({ a: bytes }, { transfer: [buffer, buffer] }),
    ).toThrow();
  });

  it("keeps distinct buffers and answers empty for a byte-free frame", () => {
    const first = takeBytesForTransfer(new Uint8Array([1]));
    const second = takeBytesForTransfer(new Uint8Array([2]));

    expect(mergeTransferLists([first, second])).toHaveLength(2);
    expect(mergeTransferLists([])).toEqual([]);
    expect(NO_TRANSFER).toEqual([]);
  });
});
