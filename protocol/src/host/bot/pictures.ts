/**
 * The picture a bot wears in place of a mascot: one still square of
 * {@link BOT_PICTURE_SIDE} pixels a side, stored as WebP or PNG.
 */
export const BOT_PICTURE_SIDE = 256;

/**
 * The most bytes a stored picture may be: the owner's figure, set above the
 * 262,400 bytes of an uncompressed 8-bit RGBA square of that side with its
 * row markers, which is the most a PNG of it needs before its framing.
 */
export const BOT_PICTURE_MAX_BYTES = 300_000;

/** The longest base64 text that many bytes encode to. */
export const BOT_PICTURE_MAX_BASE64_LENGTH =
  4 * Math.ceil(BOT_PICTURE_MAX_BYTES / 3);

export const BOT_PICTURE_MEDIA_TYPES = ["image/webp", "image/png"] as const;
export type BotPictureMediaType = (typeof BOT_PICTURE_MEDIA_TYPES)[number];

/**
 * How many leading bytes {@link botPictureHeaderOf} reads: through a PNG's
 * `IHDR` size (bytes 16 to 23) and each WebP form's (`VP8L` 21 to 24, `VP8`
 * 26 to 29, `VP8X` 24 to 29).
 */
export const BOT_PICTURE_HEADER_BYTES = 30;

export interface BotPictureHeader {
  readonly mediaType: BotPictureMediaType;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The type and size a picture's own leading bytes declare, or `null` for
 * bytes that are neither a PNG nor a WebP this reads. It decodes nothing:
 * what it answers is what the file says of itself.
 */
export function botPictureHeaderOf(bytes: Uint8Array): BotPictureHeader | null {
  if (bytes.byteLength < BOT_PICTURE_HEADER_BYTES) return null;
  const at = (index: number): number => bytes[index] ?? 0;
  const ascii = (from: number, text: string): boolean =>
    [...text].every((char, i) => at(from + i) === char.charCodeAt(0));
  if (PNG_SIGNATURE.every((byte, i) => at(i) === byte)) {
    if (!ascii(12, "IHDR")) return null;
    const be32 = (from: number): number =>
      at(from) * 0x1000000 +
      at(from + 1) * 0x10000 +
      at(from + 2) * 0x100 +
      at(from + 3);
    return { mediaType: "image/png", width: be32(16), height: be32(20) };
  }
  if (!ascii(0, "RIFF") || !ascii(8, "WEBP")) return null;
  if (ascii(12, "VP8 ")) {
    if (at(23) !== 0x9d || at(24) !== 0x01 || at(25) !== 0x2a) return null;
    return {
      mediaType: "image/webp",
      width: (at(26) + at(27) * 0x100) % 0x4000,
      height: (at(28) + at(29) * 0x100) % 0x4000,
    };
  }
  if (ascii(12, "VP8L")) {
    if (at(20) !== 0x2f) return null;
    // Two 14-bit fields, each one less than its side, packed low bit first.
    const low = at(21) + at(22) * 0x100;
    const high = at(23) + at(24) * 0x100;
    return {
      mediaType: "image/webp",
      width: (low % 0x4000) + 1,
      height: Math.floor(low / 0x4000) + (high % 0x1000) * 4 + 1,
    };
  }
  if (ascii(12, "VP8X")) {
    const le24 = (from: number): number =>
      at(from) + at(from + 1) * 0x100 + at(from + 2) * 0x10000;
    return {
      mediaType: "image/webp",
      width: le24(24) + 1,
      height: le24(27) + 1,
    };
  }
  return null;
}

/**
 * Whether a picture's bytes declare an animation: a WebP whose extended
 * header sets the animation flag, or a PNG with an animation control chunk
 * before its image data. It reads what the file says of itself and decodes
 * nothing; bytes that are neither read as still.
 */
export function botPictureIsAnimated(bytes: Uint8Array): boolean {
  const at = (index: number): number => bytes[index] ?? 0;
  const ascii = (from: number, text: string): boolean =>
    [...text].every((char, i) => at(from + i) === char.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    return ascii(12, "VP8X") && Math.floor(at(20) / 2) % 2 === 1;
  }
  if (!PNG_SIGNATURE.every((byte, i) => at(i) === byte)) return false;
  // Each chunk is a 4-byte length, a 4-byte type, the data and a 4-byte
  // check. The walk ends at the image data, the end chunk or the bytes'
  // own end, so it is bounded by the byte limit.
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.byteLength) {
    if (ascii(offset + 4, "acTL")) return true;
    if (ascii(offset + 4, "IDAT") || ascii(offset + 4, "IEND")) return false;
    const length =
      at(offset) * 0x1000000 +
      at(offset + 1) * 0x10000 +
      at(offset + 2) * 0x100 +
      at(offset + 3);
    offset += 12 + length;
  }
  return false;
}

/** Why bytes are not a picture a bot may wear, or `null` when they are one. */
export type BotPictureRefusal = "size" | "type" | "dimensions" | "animated";

/**
 * Whether `bytes` are a picture a bot may wear: within the byte limit,
 * checked first, a WebP or a PNG, exactly the square side, and still.
 */
export function botPictureRefusalOf(
  bytes: Uint8Array,
): BotPictureRefusal | null {
  if (bytes.byteLength === 0 || bytes.byteLength > BOT_PICTURE_MAX_BYTES) {
    return "size";
  }
  const header = botPictureHeaderOf(bytes);
  if (header === null) return "type";
  if (header.width !== BOT_PICTURE_SIDE || header.height !== BOT_PICTURE_SIDE) {
    return "dimensions";
  }
  return botPictureIsAnimated(bytes) ? "animated" : null;
}
