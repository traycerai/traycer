/**
 * Binary fixtures for image tests. Structure-aware enough to satisfy
 * magic-byte sniffing (`lib/attachments/image-mime-signature.ts`), which is
 * what every consumer here needs - nothing decodes them.
 */

export function pngBytesOfSize(byteLength: number): Uint8Array<ArrayBuffer> {
  if (byteLength < 8) {
    throw new Error(`PNG fixture requires at least 8 bytes, got ${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}
