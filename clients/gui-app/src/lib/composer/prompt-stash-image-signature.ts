/**
 * Canonical image format sniffing/MIME normalization for the prompt stash.
 * Shared by image preparation (`prompt-stash-image-preparation.ts`, which
 * validates and encodes a captured image before it is stashed) and persisted
 * record/blob restore validation (`prompt-stash-codec.ts`) so the two never
 * drift into disagreeing about what counts as a valid PNG/JPEG/GIF/WebP -
 * this is the sole signature implementation; nothing else in the prompt
 * stash re-derives it.
 */

export type CanonicalImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

// Loosely typed as `ReadonlySet<string>` rather than
// `ReadonlySet<CanonicalImageMimeType>`: both call sites check membership of
// an arbitrary already-typed-as-`string` field (a stored record's `mimeType`,
// an image node's `attrs.mimeType`) and only need a boolean answer, never a
// narrowed return value - `canonicalImageMimeType`/`sniffImageMimeType` below
// are what actually produce a narrowed `CanonicalImageMimeType`.
export const CANONICAL_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Normalizes a declared/attr MIME string (e.g. from a `File` or a stored attr) to the canonical form, or `null` if it names an unsupported format. */
export function canonicalImageMimeType(
  value: string,
): CanonicalImageMimeType | null {
  switch (value.trim().toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
      return "image/gif";
    case "image/webp":
      return "image/webp";
    default:
      return null;
  }
}

/** Magic-byte sniff for the 4 canonical stash image formats. */
export function sniffImageMimeType(
  bytes: Uint8Array,
): CanonicalImageMimeType | null {
  if (hasPngSignature(bytes)) return "image/png";
  if (hasJpegSignature(bytes)) return "image/jpeg";
  if (hasGifSignature(bytes)) return "image/gif";
  if (hasWebPSignature(bytes)) return "image/webp";
  return null;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function hasGifSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

function hasWebPSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    asciiAt(bytes, 0, "RIFF") &&
    asciiAt(bytes, 8, "WEBP")
  );
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}
