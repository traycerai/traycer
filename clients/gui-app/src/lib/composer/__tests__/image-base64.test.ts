import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Async,
} from "@/lib/composer/image-base64";

/**
 * `bytesToBase64Async` is a drop-in async replacement for `bytesToBase64`
 * (FileReader/Blob instead of `String.fromCharCode`, to keep a multi-MB
 * image's encode off the synchronous path) - the whole contract is that its
 * OUTPUT is byte-for-byte identical. jsdom (this package's test environment)
 * provides real `FileReader`/`Blob`, so these cases exercise that path rather
 * than the no-`FileReader` fallback.
 */
describe("bytesToBase64Async", () => {
  it("matches the sync helper for an empty array", async () => {
    const bytes = new Uint8Array([]);
    expect(await bytesToBase64Async(bytes)).toBe(bytesToBase64(bytes));
  });

  it("matches the sync helper for 1, 2 and 3 byte inputs (every padding case)", async () => {
    const oneByte = new Uint8Array([7]);
    const twoBytes = new Uint8Array([7, 8]);
    const threeBytes = new Uint8Array([7, 8, 9]);

    expect(await bytesToBase64Async(oneByte)).toBe(bytesToBase64(oneByte));
    expect(await bytesToBase64Async(twoBytes)).toBe(bytesToBase64(twoBytes));
    expect(await bytesToBase64Async(threeBytes)).toBe(
      bytesToBase64(threeBytes),
    );
  });

  it("matches the sync helper for a 100 KiB pseudo-random buffer", async () => {
    const size = 100 * 1024;
    const bytes = new Uint8Array(size);
    // A simple deterministic LCG rather than `crypto.getRandomValues` - fast,
    // reproducible, and exercises every byte value across the buffer.
    let seed = 0x2545f491;
    for (let index = 0; index < size; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      bytes[index] = seed & 0xff;
    }

    const asyncResult = await bytesToBase64Async(bytes);
    const syncResult = bytesToBase64(bytes);
    expect(asyncResult).toBe(syncResult);
    // And the encoding round-trips to the same bytes, not merely the same
    // string as some other (wrong) encoding of the same length.
    expect(base64ToBytes(asyncResult)).toEqual(bytes);
  });
});
