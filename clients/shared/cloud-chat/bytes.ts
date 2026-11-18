/**
 * The byte primitives the cloud-chat reader needs, in the one form that works
 * in every environment it runs in: the renderer, the CLI's Node process, and a
 * vitest worker.
 *
 * All three have WebCrypto on `globalThis` and both base64 globals, so nothing
 * here branches on environment - which matters more than it sounds, because the
 * alternative (a `node:crypto` import) would make this module unloadable in the
 * renderer and push every caller into supplying its own digest.
 */

/**
 * Lowercase hex sha256 of raw bytes.
 *
 * A port rather than a direct call at the use sites, so a test can drive a
 * digest that disagrees with the bytes without corrupting the bytes themselves -
 * which is how the substituted-part path gets exercised without hand-building a
 * collision.
 */
export type Sha256Hex = (bytes: Uint8Array) => Promise<string>;

/** The real one. WebCrypto, available on `globalThis` in every target. */
export const webCryptoSha256Hex: Sha256Hex = async (bytes) => {
  // A fresh copy into a plain ArrayBuffer: a `Uint8Array` may be a view onto a
  // larger buffer (every subarray is), and `digest` hashes the WHOLE buffer, so
  // passing the view's buffer would silently hash the wrong bytes.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** UTF-8 bytes of a string. The encoding every digest on this path is over. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 text of raw bytes. Throws on invalid UTF-8 rather than substituting. */
export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Base64 -> bytes.
 *
 * `atob` gives a binary string (one char per byte, all < 256), so the
 * charCode walk below is lossless. Throws on malformed input, which the reader
 * treats as a transport failure rather than a corrupt chat: bytes that never
 * decoded are bytes that never arrived.
 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Bytes -> base64. Used by test fixtures that build wire responses. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
