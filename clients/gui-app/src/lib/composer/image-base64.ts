/**
 * Base64 <-> bytes helpers for composer image attachments. Shared so the copy
 * re-inline (chat message -> clipboard), the landing paste ingest
 * (clipboard -> landing image store), and the landing submit re-inline all
 * encode/decode identically instead of each rolling its own loop.
 */
import type { ImageBytes } from "@/lib/attachments/image-bytes";

const CHUNK_SIZE = 0x8000;

/**
 * Encode bytes to a base64 string. Chunked so a multi-MB image's byte array
 * never overflows the call stack via a single spread into `String.fromCharCode`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

/**
 * The same encoding as {@link bytesToBase64}, produced off the main thread.
 *
 * `FileReader.readAsDataURL` hands the bytes to the browser's own encoder and
 * resolves on the event loop, so a multi-megabyte image costs the caller a
 * microtask rather than the ~70 ms of `String.fromCharCode` work the
 * synchronous helper spends per 3.75 MiB. The output is byte-for-byte the
 * standard padded base64 the sync path returns; only the data-URL prefix is
 * stripped.
 *
 * For an upload path that is already asynchronous. A caller that must stay in
 * ONE stack frame (the landing submit's session fast path) keeps the sync
 * helper on purpose - see `sessionBase64ByHash`.
 *
 * Falls back to the synchronous helper where `FileReader` does not exist
 * (a bare Node test environment), so the result never depends on the host.
 */
export function bytesToBase64Async(bytes: Uint8Array): Promise<string> {
  if (typeof FileReader === "undefined" || typeof Blob === "undefined") {
    return Promise.resolve(bytesToBase64(bytes));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("base64 encode failed"));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("base64 encode produced no data URL"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? "" : result.slice(comma + 1));
    };
    // A view over a plain `ArrayBuffer` is a `BlobPart`; one over a shared
    // buffer is not, and is copied. Image bytes come from IndexedDB and the
    // clipboard, which never hand out shared memory, so the copy is theory.
    const part: Uint8Array<ArrayBuffer> =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    reader.readAsDataURL(new Blob([part]));
  });
}

/**
 * Decode a base64 string to bytes, or `null` when the input is not valid base64
 * (a corrupt clipboard payload) so callers can drop the image rather than throw.
 * The returned view owns a fresh `ArrayBuffer`, matching the `putImage` contract.
 */
export function base64ToBytes(base64: string): ImageBytes | null {
  const binary = decodeBase64(base64);
  if (binary === null) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeBase64(base64: string): string | null {
  try {
    return atob(base64);
  } catch {
    return null;
  }
}
