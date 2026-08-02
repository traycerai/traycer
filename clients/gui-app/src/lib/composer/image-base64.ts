/**
 * Base64 <-> bytes helpers for composer image attachments. Shared so the copy
 * re-inline (chat message -> clipboard), the landing paste ingest
 * (clipboard -> landing image store), and the landing submit re-inline all
 * encode/decode identically instead of each rolling its own loop.
 */

/** A view guaranteed to be backed by a plain `ArrayBuffer` (not shared). */
type ImageBytes = Uint8Array<ArrayBuffer>;

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
