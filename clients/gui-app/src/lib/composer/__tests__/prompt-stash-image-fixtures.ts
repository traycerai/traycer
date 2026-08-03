/**
 * Binary fixtures for prompt-stash image preparation tests.
 * Structure-aware builders satisfy magic-byte sniffing and GIF/WebP parsers.
 */

export const STATIC_MAX = 975 * 1024;
export const IMAGE_MAX = 5 * 1024 * 1024;

export function pngBytesOfSize(byteLength: number): Uint8Array<ArrayBuffer> {
  if (byteLength < 8) {
    throw new Error(`PNG fixture requires at least 8 bytes, got ${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

export function jpegBytesOfSize(byteLength: number): Uint8Array<ArrayBuffer> {
  if (byteLength < 3) {
    throw new Error(
      `JPEG fixture requires at least 3 bytes, got ${byteLength}`,
    );
  }
  const bytes = new Uint8Array(byteLength);
  bytes.set([0xff, 0xd8, 0xff], 0);
  return bytes;
}

/** Minimal structurally valid single-frame GIF89a (1×1). */
export function minimalGif(): Uint8Array<ArrayBuffer> {
  return singleFrameGifBytesOfSize(32);
}

/**
 * Structurally valid single-frame GIF of exact `byteLength`.
 * Prefix + one image descriptor + LZW + raster sub-blocks + trailer.
 */
export function singleFrameGifBytesOfSize(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  // 19-byte header/GCT + 11-byte image desc/LZW + 1 trailer + raster region
  const overheadWithoutRaster = 31;
  if (byteLength < overheadWithoutRaster + 1) {
    throw new Error(`GIF fixture too small: ${byteLength}`);
  }
  const rasterRegion = byteLength - overheadWithoutRaster;
  const dataLength = rasterDataLengthForRegion(rasterRegion);
  const out = new Uint8Array(byteLength);
  out.set(
    [
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      0x01,
      0x00,
      0x01,
      0x00, // 1×1
      0x80,
      0x00,
      0x00, // GCT flag, 2 colors
      0x00,
      0x00,
      0x00, // color 0
      0xff,
      0xff,
      0xff, // color 1
      0x2c, // image descriptor
      0x00,
      0x00,
      0x00,
      0x00, // left, top
      0x01,
      0x00,
      0x01,
      0x00, // 1×1
      0x00, // no local color table
      0x02, // LZW minimum code size
    ],
    0,
  );
  let offset = 30;
  offset = writeGifSubBlocks(out, offset, dataLength);
  out[offset] = 0x3b;
  return out;
}

/**
 * Structurally valid two-frame (animated) GIF of exact `byteLength`.
 * Prefix + GCE + frame1 + GCE + frame2 (padded) + trailer.
 * Production treats frameCount > 1 as verbatim animation.
 */
export function twoFrameGifBytesOfSize(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  // prefix(19) + 2×(GCE 8 + desc/LZW 11) + trailer 1 = 57 fixed, + 2 rasters ≥1 each
  const PREFIX = 19;
  const GCE = 8;
  const FRAME_FIXED = 11;
  const TRAILER = 1;
  const fixed = PREFIX + 2 * (GCE + FRAME_FIXED) + TRAILER;
  if (byteLength < fixed + 2) {
    throw new Error(
      `Two-frame GIF fixture too small: ${byteLength} (need ≥ ${fixed + 2})`,
    );
  }
  const remaining = byteLength - fixed;
  const raster1 = 1;
  const raster2 = remaining - raster1;
  const data1 = rasterDataLengthForRegion(raster1);
  const data2 = rasterDataLengthForRegion(raster2);

  const out = new Uint8Array(byteLength);
  out.set(
    [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    ],
    0,
  );
  let offset = PREFIX;

  // Graphic Control Extension + frame 1
  out.set([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00], offset);
  offset += GCE;
  out.set(
    [0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02],
    offset,
  );
  offset += FRAME_FIXED;
  offset = writeGifSubBlocks(out, offset, data1);

  // Graphic Control Extension + frame 2 (holds remaining pad)
  out.set([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00], offset);
  offset += GCE;
  out.set(
    [0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02],
    offset,
  );
  offset += FRAME_FIXED;
  offset = writeGifSubBlocks(out, offset, data2);

  out[offset] = 0x3b;
  if (offset + 1 !== byteLength) {
    throw new Error(
      `Two-frame GIF size mismatch: wrote ${offset + 1}, wanted ${byteLength}`,
    );
  }
  return out;
}

function writeU32LE(value: number): [number, number, number, number] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function writeFourCC(name: string): number[] {
  return [
    name.charCodeAt(0),
    name.charCodeAt(1),
    name.charCodeAt(2),
    name.charCodeAt(3),
  ];
}

function webpChunk(name: string, data: readonly number[]): number[] {
  const pad = data.length % 2 === 1 ? [0] : [];
  return [...writeFourCC(name), ...writeU32LE(data.length), ...data, ...pad];
}

/**
 * Minimal structurally valid static WebP (VP8 payload).
 * RIFF chunks are word-aligned, so only even total lengths are reachable.
 */
export function staticWebpBytesOfSize(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  if (byteLength < 20) {
    throw new Error(`Static WebP fixture too small: ${byteLength}`);
  }
  if (byteLength % 2 !== 0) {
    throw new Error(`Static WebP fixture size must be even: ${byteLength}`);
  }
  const need = byteLength - 20;
  const dataLen = need % 2 === 0 ? need : need - 1;
  const data = Array.from({ length: dataLen }, (_, i) => (i + 1) & 0xff);
  const chunk = webpChunk("VP8 ", data);
  const riffPayload = 4 + chunk.length;
  const out = new Uint8Array(8 + riffPayload);
  out.set(writeFourCC("RIFF"), 0);
  out.set(writeU32LE(riffPayload), 4);
  out.set(writeFourCC("WEBP"), 8);
  out.set(chunk, 12);
  if (out.byteLength !== byteLength) {
    throw new Error(
      `Static WebP size mismatch: wanted ${byteLength}, got ${out.byteLength}`,
    );
  }
  return out;
}

/** Structurally valid animated WebP (VP8X anim flag + ANMF). */
export function animatedWebpBytesOfSize(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  if (byteLength < 38 + 1) {
    throw new Error(`Animated WebP fixture too small: ${byteLength}`);
  }
  if (byteLength % 2 !== 0) {
    throw new Error(`Animated WebP fixture size must be even: ${byteLength}`);
  }
  const need = byteLength - 38;
  const anmfData = need % 2 === 0 ? need : need - 1;
  if (anmfData < 1) {
    throw new Error(
      `Animated WebP fixture too small after pad adjust: ${byteLength}`,
    );
  }
  const vp8x = webpChunk("VP8X", [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const anmfPayload = Array.from(
    { length: anmfData },
    (_, i) => (i + 3) & 0xff,
  );
  const anmf = webpChunk("ANMF", anmfPayload);
  const body = [...vp8x, ...anmf];
  const riffPayload = 4 + body.length;
  const out = new Uint8Array(8 + riffPayload);
  out.set(writeFourCC("RIFF"), 0);
  out.set(writeU32LE(riffPayload), 4);
  out.set(writeFourCC("WEBP"), 8);
  out.set(body, 12);
  if (out.byteLength !== byteLength) {
    throw new Error(
      `Animated WebP size mismatch: wanted ${byteLength}, got ${out.byteLength}`,
    );
  }
  return out;
}

/**
 * Genuine multi-frame GIF that still passes structural frame counting, but
 * with a deliberately corrupt LZW minimum-code size so a real decoder rejects
 * the payload. Used with a rejecting codec mock in preparation regressions.
 */
export function structurallyAnimatedGifWithCorruptLzw(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  const bytes = twoFrameGifBytesOfSize(byteLength);
  // PREFIX(19) + GCE(8) + image descriptor without LZW(10) → frame-1 LZW min.
  const frame1LzwMinCodeOffset = 19 + 8 + 10;
  bytes[frame1LzwMinCodeOffset] = 0xff;
  return bytes;
}

/**
 * Animated WebP that still passes the chunk/animation parser, but with
 * zeroed ANMF frame payload so a real decoder rejects the codec stream.
 */
export function structurallyAnimatedWebpWithCorruptFrames(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  const bytes = animatedWebpBytesOfSize(byteLength);
  // RIFF/WEBP(12) + VP8X chunk(18) + ANMF FourCC+size(8) → ANMF data start.
  const anmfDataStart = 12 + 18 + 8;
  for (let i = anmfDataStart; i < bytes.byteLength; i += 1) {
    bytes[i] = 0;
  }
  return bytes;
}

export function encodedWebpBytesOfSize(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  return staticWebpBytesOfSize(byteLength);
}

export function encodedJpegBytesOfSize(
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  return jpegBytesOfSize(byteLength);
}

/**
 * Given a raster sub-block region length (including the terminating 0),
 * return the pure data-byte count D such that D + blockHeaders + 1 = region.
 */
function rasterDataLengthForRegion(region: number): number {
  if (region === 1) return 0;
  const target = region - 1;
  let dataLength = Math.floor((target * 255) / 256);
  const measure = (d: number): number => (d === 0 ? 0 : d + Math.ceil(d / 255));
  while (dataLength > 0 && measure(dataLength) > target) dataLength -= 1;
  while (measure(dataLength) < target) dataLength += 1;
  if (measure(dataLength) !== target) {
    throw new Error(
      `Cannot construct GIF raster region of ${region} bytes (target ${target})`,
    );
  }
  return dataLength;
}

function writeGifSubBlocks(
  out: Uint8Array,
  offset: number,
  dataLength: number,
): number {
  let remaining = dataLength;
  let o = offset;
  while (remaining > 0) {
    const chunk = Math.min(255, remaining);
    out[o] = chunk;
    o += 1 + chunk;
    remaining -= chunk;
  }
  out[o] = 0;
  return o + 1;
}
