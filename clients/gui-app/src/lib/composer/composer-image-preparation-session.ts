/**
 * The shared image preparer. One policy shape, several call sites:
 *
 * - every composer paste/drop surface prepares with `PREPARED_IMAGE_POLICY`
 *   (source ≤ 50 MiB, longest edge ≤ 2000 px, output ≤ 3.75 MiB) so the bytes
 *   that leave the renderer are already within every provider's ceiling;
 * The prompt stash was the second call site and is gone (#1979 replaced it with
 * the composer Drafts control), taking its policy with it. What the stash left
 * behind is a BOUND rather than a policy: `landing-image-import.ts` still
 * migrates legacy stash blobs into the landing partition verbatim, so the
 * budget's per-image ceiling is still the larger of the two numbers. That
 * constant now lives with the budget, which is the module that reasons about it.
 *
 * Header sniffing (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X, GIF LSD) answers
 * "how big is this image" without a decode, so a static image already within
 * the edge and under the ceiling passes through with no bitmap allocated at
 * all. EXIF orientation is honoured by the decoder (`bitmap-codec.ts`).
 */
import {
  decodeBitmap,
  createBitmapCanvas,
  bitmapCanvasToBlob,
  type DecodedBitmap,
} from "@/lib/images/bitmap-codec";
import {
  canonicalImageMimeType,
  sniffImageMimeType,
  type CanonicalImageMimeType,
} from "@/lib/attachments/image-mime-signature";
import type { ImageBytes } from "@/lib/attachments/image-bytes";

/** Universal paste policy: bounds the bitmap a single paste can allocate. */
export const PREPARED_IMAGE_SOURCE_CEILING = 50 * 1024 * 1024;
/**
 * Anthropic's limit once a request holds more than 20 images, OpenCode's
 * default, Claude Code's paste downscale, and under Codex core's 2048 fit.
 */
export const PREPARED_IMAGE_MAX_LONGEST_EDGE = 2000;
/** 3.75 MiB — 5 MiB once base64-encoded, the intersection of the provider ceilings. */
export const PREPARED_IMAGE_MAX_BYTES = 3_932_160;

const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const SCALE_STEPS = [1, 0.75, 0.55] as const;

export type { CanonicalImageMimeType };

/**
 * Ceilings one `prepare` call answers to.
 *
 * `animationCeiling` is separate from `byteCeiling` because an animated GIF or
 * WebP cannot be re-encoded frame-faithfully — it is kept verbatim or refused,
 * so its limit is not the limit a re-encode has to hit. The universal policy
 * sets both to the output ceiling; the stash keeps animations verbatim through
 * its 5 MiB source ceiling, which is what it did before this module was shared.
 */
export interface PreparationPolicy {
  readonly sourceCeiling: number;
  readonly maxLongestEdge: number;
  readonly byteCeiling: number;
  readonly animationCeiling: number;
}

export const PREPARED_IMAGE_POLICY: PreparationPolicy = {
  sourceCeiling: PREPARED_IMAGE_SOURCE_CEILING,
  maxLongestEdge: PREPARED_IMAGE_MAX_LONGEST_EDGE,
  byteCeiling: PREPARED_IMAGE_MAX_BYTES,
  animationCeiling: PREPARED_IMAGE_MAX_BYTES,
};

/**
 * Refusal by size: the source is over the policy's source ceiling, an
 * animation is over its animation ceiling, or the ladder exhausted without
 * producing bytes that fit. Every other failure (undecodable, unsupported
 * format, bytes that disagree with their declared format) is an ordinary
 * `Error` — the distinction is what lets a paste surface toast "too large even
 * after resizing" for one and "couldn't attach the image" for the other.
 */
export class ImageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageTooLargeError";
  }
}

export type DecodedImage = DecodedBitmap;

/** The formats a canvas encode can target. GIF is decodable but not encodable. */
export type EncodableImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ImagePreparationCodec {
  readonly decode: (args: {
    readonly bytes: ImageBytes;
    readonly mimeType: CanonicalImageMimeType;
  }) => Promise<DecodedImage>;
  readonly encode: (args: {
    readonly image: DecodedImage;
    readonly width: number;
    readonly height: number;
    readonly mimeType: EncodableImageMimeType;
    readonly quality: number;
    readonly whiteMatte: boolean;
  }) => Promise<ImageBytes | null>;
  readonly supportsWebP: () => Promise<boolean>;
}

/**
 * Which rule accepted the bytes. Reported so a caller (and the size matrix in
 * the tests) can tell a pass-through from a re-encode without re-deriving it.
 */
export type PreparedImageStep =
  | "verbatim"
  | "animated-verbatim"
  | "source-family"
  | "recompressed";

export interface PreparedImage {
  readonly bytes: ImageBytes;
  readonly fileName: string;
  readonly mimeType: CanonicalImageMimeType;
  readonly byteLength: number;
  readonly step: PreparedImageStep;
}

export interface ImagePreparationSession {
  readonly prepare: (args: {
    readonly bytes: ImageBytes;
    readonly fileName: string;
    readonly declaredMimeType: string;
  }) => Promise<PreparedImage>;
}

interface EncodedCandidate {
  readonly bytes: ImageBytes;
  readonly mimeType: EncodableImageMimeType;
}

interface BoundedDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Creates one capture-scoped preparation session. The session owns the WebP
 * support probe so a paste holding several oversized images probes the browser
 * codec exactly once.
 */
export function createImagePreparationSession(args: {
  readonly policy: PreparationPolicy;
  readonly codec: ImagePreparationCodec | undefined;
}): ImagePreparationSession {
  const policy = args.policy;
  const selectedCodec = args.codec ?? browserImagePreparationCodec;
  let webPSupport: Promise<boolean> | null = null;
  const probeWebPSupport = (): Promise<boolean> => {
    webPSupport ??= selectedCodec.supportsWebP().catch(() => false);
    return webPSupport;
  };

  return {
    prepare: async (input) => {
      const sourceMimeType = validateSourceImage(
        input.bytes,
        input.declaredMimeType,
        policy,
      );
      const preserveAnimation = isVerbatimAnimation(
        input.bytes,
        sourceMimeType,
      );

      // The sniff-only path: dimensions from the header, no bitmap. An
      // animation never takes it — it is still decode-validated below, because
      // being kept verbatim is exactly why nothing downstream would ever catch
      // a payload a real decoder rejects.
      if (!preserveAnimation) {
        const sniffed = sniffImageDimensions(input.bytes, sourceMimeType);
        if (
          sniffed !== null &&
          Math.max(sniffed.width, sniffed.height) <= policy.maxLongestEdge &&
          input.bytes.byteLength <= policy.byteCeiling
        ) {
          return preparedVerbatim(
            input.bytes,
            input.fileName,
            sourceMimeType,
            "verbatim",
          );
        }
      }

      let decoded: DecodedImage;
      try {
        decoded = await selectedCodec.decode({
          bytes: input.bytes,
          mimeType: sourceMimeType,
        });
      } catch {
        throw new Error("A prompt image could not be decoded.");
      }

      try {
        validateDecodedDimensions(decoded);
        if (preserveAnimation) {
          if (input.bytes.byteLength <= policy.animationCeiling) {
            return preparedVerbatim(
              input.bytes,
              input.fileName,
              sourceMimeType,
              "animated-verbatim",
            );
          }
          throw new ImageTooLargeError(
            "An animated prompt image is too large and cannot be re-encoded.",
          );
        }

        const bounded = boundedDimensions(
          decoded.width,
          decoded.height,
          policy.maxLongestEdge,
        );
        const scaled =
          bounded.width !== decoded.width || bounded.height !== decoded.height;
        // A header this module could not read (or one that disagreed with the
        // decoder) lands here: the decoded size fits and no scale is needed, so
        // the source bytes are still the best answer.
        if (!scaled && input.bytes.byteLength <= policy.byteCeiling) {
          return preparedVerbatim(
            input.bytes,
            input.fileName,
            sourceMimeType,
            "verbatim",
          );
        }

        const supportsWebP = await probeWebPSupport();
        if (scaled) {
          const sourceFamily = await encodeInSourceFamily({
            codec: selectedCodec,
            image: decoded,
            bounded,
            sourceMimeType,
            byteCeiling: policy.byteCeiling,
            supportsWebP,
          });
          if (sourceFamily !== null) {
            return preparedEncoded(
              sourceFamily,
              input.fileName,
              "source-family",
            );
          }
        }

        const compressed = await compressDecodedImage({
          codec: selectedCodec,
          image: decoded,
          bounded,
          supportsWebP,
          byteCeiling: policy.byteCeiling,
        });
        if (compressed !== null) {
          return preparedEncoded(compressed, input.fileName, "recompressed");
        }
      } finally {
        decoded.close();
      }

      throw new ImageTooLargeError(
        "A prompt image could not be compressed enough to stash.",
      );
    },
  };
}

function validateSourceImage(
  bytes: ImageBytes,
  declaredMimeType: string,
  policy: PreparationPolicy,
): CanonicalImageMimeType {
  if (bytes.byteLength === 0) {
    throw new Error("A prompt image is empty.");
  }
  if (bytes.byteLength > policy.sourceCeiling) {
    throw new ImageTooLargeError(
      `A prompt image is over the ${megabyteLabel(policy.sourceCeiling)} MB limit.`,
    );
  }
  if (!declaredMimeType.toLowerCase().startsWith("image/")) {
    throw new Error("A prompt attachment is not an image.");
  }
  const declared = canonicalImageMimeType(declaredMimeType);
  if (declared === null) {
    throw new Error("A prompt image uses an unsupported format.");
  }
  const actual = sniffImageMimeType(bytes);
  if (actual === null || actual !== declared) {
    throw new Error("A prompt image's bytes do not match its format.");
  }
  return actual;
}

function megabyteLabel(byteCeiling: number): number {
  return Math.round(byteCeiling / (1024 * 1024));
}

function isVerbatimAnimation(
  bytes: Uint8Array,
  mimeType: CanonicalImageMimeType,
): boolean {
  if (mimeType === "image/gif") {
    return countGifFrames(bytes) > 1;
  }
  if (mimeType !== "image/webp") return false;
  return validateWebPStructureAndDetectAnimation(bytes);
}

function countGifFrames(bytes: Uint8Array): number {
  if (bytes.byteLength < 14) throw invalidImageBytes();
  let offset = 13;
  const logicalScreenPacked = bytes[10];
  if ((logicalScreenPacked & 0x80) !== 0) {
    offset += 3 * 2 ** ((logicalScreenPacked & 0x07) + 1);
  }
  let frameCount = 0;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset];
    if (marker === 0x3b) {
      if (frameCount === 0 || offset !== bytes.byteLength - 1) {
        throw invalidImageBytes();
      }
      return frameCount;
    }
    if (marker === 0x21) {
      if (offset + 2 >= bytes.byteLength) throw invalidImageBytes();
      offset = skipGifSubBlocks(bytes, offset + 2);
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 10 > bytes.byteLength) throw invalidImageBytes();
      const imagePacked = bytes[offset + 9];
      offset += 10;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      }
      if (offset >= bytes.byteLength) throw invalidImageBytes();
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      frameCount += 1;
      continue;
    }
    throw invalidImageBytes();
  }
  throw invalidImageBytes();
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.byteLength) {
    const size = bytes[offset];
    offset += 1;
    if (size === 0) return offset;
    offset += size;
    if (offset > bytes.byteLength) throw invalidImageBytes();
  }
  throw invalidImageBytes();
}

function validateWebPStructureAndDetectAnimation(bytes: Uint8Array): boolean {
  const riffPayloadLength = readUint32LittleEndian(bytes, 4);
  const end = riffPayloadLength + 8;
  if (end !== bytes.byteLength || end < 20) throw invalidImageBytes();
  let animated = false;
  let imagePayloadSeen = false;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) throw invalidImageBytes();
    const chunkName = ascii(bytes, offset, 4);
    const chunkLength = readUint32LittleEndian(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd > end) throw invalidImageBytes();
    const chunk = inspectWebPChunk(bytes, chunkName, dataStart, chunkLength);
    animated ||= chunk.animated;
    imagePayloadSeen ||= chunk.imagePayload;
    offset = dataEnd + (chunkLength % 2);
    if (offset > end) throw invalidImageBytes();
  }
  if (!imagePayloadSeen) throw invalidImageBytes();
  return animated;
}

function inspectWebPChunk(
  bytes: Uint8Array,
  chunkName: string,
  dataStart: number,
  chunkLength: number,
): { readonly animated: boolean; readonly imagePayload: boolean } {
  if (chunkName === "VP8X") {
    if (chunkLength !== 10) throw invalidImageBytes();
    return {
      animated: (bytes[dataStart] & 0x02) !== 0,
      imagePayload: false,
    };
  }
  if (chunkName === "ANIM") {
    return { animated: true, imagePayload: false };
  }
  if (chunkName === "ANMF") {
    return { animated: true, imagePayload: true };
  }
  return {
    animated: false,
    imagePayload: chunkName === "VP8 " || chunkName === "VP8L",
  };
}

/**
 * The single bounded attempt in the source's own family, tried first after a
 * scale: a downscaled PNG re-encodes losslessly and usually fits, and a JPEG or
 * WebP source re-encodes at q0.92 without changing format. Whether a 2000 px
 * screenshot PNG actually fits is measured, not assumed — a miss just falls
 * through to the ladder below, one wasted encode.
 */
async function encodeInSourceFamily(args: {
  readonly codec: ImagePreparationCodec;
  readonly image: DecodedImage;
  readonly bounded: BoundedDimensions;
  readonly sourceMimeType: CanonicalImageMimeType;
  readonly byteCeiling: number;
  readonly supportsWebP: boolean;
}): Promise<EncodedCandidate | null> {
  const target = sourceFamilyEncodeTarget(args.sourceMimeType);
  if (target === null) return null;
  if (target === "image/webp" && !args.supportsWebP) return null;
  const candidate = await tryEncodeCandidate(
    {
      codec: args.codec,
      image: args.image,
      bounded: args.bounded,
      mimeType: target,
    },
    {
      scale: 1,
      quality: target === "image/png" ? 1 : QUALITY_STEPS[0],
    },
  );
  if (candidate === null) return null;
  if (sniffImageMimeType(candidate) !== target) return null;
  if (candidate.byteLength > args.byteCeiling) return null;
  return { bytes: candidate, mimeType: target };
}

function sourceFamilyEncodeTarget(
  sourceMimeType: CanonicalImageMimeType,
): EncodableImageMimeType | null {
  switch (sourceMimeType) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
      return "image/jpeg";
    case "image/webp":
      return "image/webp";
    case "image/gif":
      // Single-frame GIF: no canvas encoder, so the ladder owns it outright.
      return null;
  }
}

async function compressDecodedImage(args: {
  readonly codec: ImagePreparationCodec;
  readonly image: DecodedImage;
  readonly bounded: BoundedDimensions;
  readonly supportsWebP: boolean;
  readonly byteCeiling: number;
}): Promise<EncodedCandidate | null> {
  if (args.supportsWebP) {
    const webP = await encodeWithinLimit({ ...args, mimeType: "image/webp" });
    if (webP !== null) return { bytes: webP, mimeType: "image/webp" };
  }
  const jpeg = await encodeWithinLimit({ ...args, mimeType: "image/jpeg" });
  return jpeg === null ? null : { bytes: jpeg, mimeType: "image/jpeg" };
}

/**
 * Quality-outer, scale-inner: every scale step is tried at q0.92 before the
 * quality drops, because downscaling costs less legibility than lossy
 * recompression on the text-heavy screenshots this path mostly sees.
 */
async function encodeWithinLimit(args: {
  readonly codec: ImagePreparationCodec;
  readonly image: DecodedImage;
  readonly bounded: BoundedDimensions;
  readonly mimeType: EncodableImageMimeType;
  readonly byteCeiling: number;
}): Promise<ImageBytes | null> {
  const attempts = QUALITY_STEPS.flatMap((quality) =>
    SCALE_STEPS.map((scale) => ({ scale, quality })),
  );
  for (const attempt of attempts) {
    const candidate = await tryEncodeCandidate(args, attempt);
    if (
      candidate !== null &&
      sniffImageMimeType(candidate) === args.mimeType &&
      candidate.byteLength <= args.byteCeiling
    ) {
      return candidate;
    }
  }
  return null;
}

async function tryEncodeCandidate(
  args: {
    readonly codec: ImagePreparationCodec;
    readonly image: DecodedImage;
    readonly bounded: BoundedDimensions;
    readonly mimeType: EncodableImageMimeType;
  },
  attempt: { readonly scale: number; readonly quality: number },
): Promise<ImageBytes | null> {
  try {
    return await args.codec.encode({
      image: args.image,
      width: Math.max(1, Math.round(args.bounded.width * attempt.scale)),
      height: Math.max(1, Math.round(args.bounded.height * attempt.scale)),
      mimeType: args.mimeType,
      quality: attempt.quality,
      whiteMatte: args.mimeType === "image/jpeg",
    });
  } catch {
    return null;
  }
}

function preparedVerbatim(
  bytes: ImageBytes,
  fileName: string,
  mimeType: CanonicalImageMimeType,
  step: PreparedImageStep,
): PreparedImage {
  return {
    bytes,
    fileName: canonicalPreparedImageFileName(fileName, mimeType),
    mimeType,
    byteLength: bytes.byteLength,
    step,
  };
}

function preparedEncoded(
  candidate: EncodedCandidate,
  fileName: string,
  step: PreparedImageStep,
): PreparedImage {
  return {
    bytes: candidate.bytes,
    fileName: canonicalPreparedImageFileName(fileName, candidate.mimeType),
    mimeType: candidate.mimeType,
    byteLength: candidate.bytes.byteLength,
    step,
  };
}

/** Re-extends a file name whenever preparation changed the encoding. */
export function canonicalPreparedImageFileName(
  fileName: string,
  mimeType: CanonicalImageMimeType,
): string {
  const extension = extensionForMimeType(mimeType);
  const trimmed = fileName.trim();
  const safeName = trimmed.length > 0 ? trimmed : "image";
  const lastSlash = Math.max(
    safeName.lastIndexOf("/"),
    safeName.lastIndexOf("\\"),
  );
  const directory = safeName.slice(0, lastSlash + 1);
  const basename = safeName.slice(lastSlash + 1);
  const extensionIndex = basename.lastIndexOf(".");
  const stem =
    extensionIndex > 0
      ? basename.slice(0, extensionIndex)
      : basename || "image";
  return `${directory}${stem}.${extension}`;
}

function extensionForMimeType(mimeType: CanonicalImageMimeType): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
  }
}

function validateDecodedDimensions(image: DecodedImage): void {
  if (
    !Number.isFinite(image.width) ||
    !Number.isFinite(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new Error("A prompt image has invalid dimensions.");
  }
}

function boundedDimensions(
  width: number,
  height: number,
  maxLongestEdge: number,
): BoundedDimensions {
  const scale = Math.min(1, maxLongestEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface SniffedImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Pixel dimensions straight from the container header, or `null` when this
 * module cannot read them with certainty (an unusual JPEG marker stream, a
 * WebP whose bitstream header is not where the spec puts it, a truncated
 * file). `null` is never a refusal — it only means the decoder has to answer
 * instead, which is the pre-sniff behaviour.
 */
export function sniffImageDimensions(
  bytes: Uint8Array,
  mimeType: CanonicalImageMimeType,
): SniffedImageDimensions | null {
  switch (mimeType) {
    case "image/png":
      return sniffPngDimensions(bytes);
    case "image/jpeg":
      return sniffJpegDimensions(bytes);
    case "image/gif":
      return sniffGifDimensions(bytes);
    case "image/webp":
      return sniffWebPDimensions(bytes);
  }
}

/** IHDR is mandated to be the first chunk, so width/height sit at 16/20. */
function sniffPngDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (bytes.byteLength < 24) return null;
  if (ascii(bytes, 12, 4) !== "IHDR") return null;
  return validDimensions(
    readUint32BigEndian(bytes, 16),
    readUint32BigEndian(bytes, 20),
  );
}

/** Logical Screen Descriptor: two little-endian u16 right after the magic. */
function sniffGifDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  if (bytes.byteLength < 10) return null;
  return validDimensions(
    readUint16LittleEndian(bytes, 6),
    readUint16LittleEndian(bytes, 8),
  );
}

/**
 * Walks the JPEG marker stream to the first Start-Of-Frame. Entropy-coded data
 * only ever follows SOS, so a plain segment walk cannot run into it here; any
 * byte that is not a marker introducer aborts the sniff rather than guessing.
 */
function sniffJpegDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    // Fill bytes: any number of 0xff may precede the marker code itself.
    let markerOffset = offset + 1;
    while (marker === 0xff && markerOffset + 1 < bytes.byteLength) {
      markerOffset += 1;
      marker = bytes[markerOffset];
    }
    if (isJpegStandaloneMarker(marker)) {
      offset = markerOffset + 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const segmentStart = markerOffset + 1;
    if (segmentStart + 2 > bytes.byteLength) return null;
    const segmentLength = readUint16BigEndian(bytes, segmentStart);
    if (segmentLength < 2) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentStart + 7 > bytes.byteLength) return null;
      return validDimensions(
        readUint16BigEndian(bytes, segmentStart + 5),
        readUint16BigEndian(bytes, segmentStart + 3),
      );
    }
    offset = segmentStart + segmentLength;
  }
  return null;
}

function isJpegStandaloneMarker(marker: number): boolean {
  if (marker === 0xd8 || marker === 0x01) return true;
  return marker >= 0xd0 && marker <= 0xd7;
}

function isJpegStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  // DHT / JPG / DAC share the 0xCx range but are not frame headers.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * VP8X carries the canvas size when present (it always precedes the image
 * chunks); otherwise the lossy or lossless bitstream header does.
 */
function sniffWebPDimensions(bytes: Uint8Array): SniffedImageDimensions | null {
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkName = ascii(bytes, offset, 4);
    const chunkLength = readUint32LittleEndian(bytes, offset + 4);
    const dataStart = offset + 8;
    if (dataStart + chunkLength > bytes.byteLength) return null;
    const dimensions = sniffWebPChunkDimensions(
      bytes,
      chunkName,
      dataStart,
      chunkLength,
    );
    if (dimensions !== null) return dimensions;
    offset = dataStart + chunkLength + (chunkLength % 2);
  }
  return null;
}

function sniffWebPChunkDimensions(
  bytes: Uint8Array,
  chunkName: string,
  dataStart: number,
  chunkLength: number,
): SniffedImageDimensions | null {
  if (chunkName === "VP8X") {
    if (chunkLength !== 10) return null;
    return validDimensions(
      readUint24LittleEndian(bytes, dataStart + 4) + 1,
      readUint24LittleEndian(bytes, dataStart + 7) + 1,
    );
  }
  if (chunkName === "VP8 ") {
    if (chunkLength < 10) return null;
    if (
      bytes[dataStart + 3] !== 0x9d ||
      bytes[dataStart + 4] !== 0x01 ||
      bytes[dataStart + 5] !== 0x2a
    ) {
      return null;
    }
    return validDimensions(
      readUint16LittleEndian(bytes, dataStart + 6) & 0x3fff,
      readUint16LittleEndian(bytes, dataStart + 8) & 0x3fff,
    );
  }
  if (chunkName === "VP8L") {
    if (chunkLength < 5) return null;
    if (bytes[dataStart] !== 0x2f) return null;
    const packed = readUint32LittleEndian(bytes, dataStart + 1);
    return validDimensions(
      (packed & 0x3fff) + 1,
      ((packed >>> 14) & 0x3fff) + 1,
    );
  }
  return null;
}

function validDimensions(
  width: number,
  height: number,
): SniffedImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const value = bytes[offset + index];
    result += String.fromCharCode(value);
  }
  return result;
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  return (a + b * 2 ** 8 + c * 2 ** 16 + d * 2 ** 24) >>> 0;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  return (a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d) >>> 0;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  return a + b * 2 ** 8 + c * 2 ** 16;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 2 ** 8;
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 2 ** 8 + bytes[offset + 1];
}

function invalidImageBytes(): Error {
  return new Error("A prompt image contains invalid image data.");
}

const browserImagePreparationCodec: ImagePreparationCodec = {
  decode: async ({ bytes, mimeType }) => {
    if (typeof createImageBitmap !== "function") {
      throw new Error("This browser cannot decode images for stashing.");
    }
    return decodeBitmap(new Blob([bytes], { type: mimeType }));
  },
  encode: async (args) => {
    const canvas = createBitmapCanvas(args.width, args.height);
    try {
      const context = canvas.getContext("2d");
      if (context === null) return null;
      if (args.whiteMatte) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, args.width, args.height);
      }
      context.drawImage(args.image.source, 0, 0, args.width, args.height);
      const blob = await bitmapCanvasToBlob(
        canvas,
        args.mimeType,
        args.quality,
      );
      if (blob === null || blob.type !== args.mimeType) return null;
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
  supportsWebP: async () => {
    const canvas = createBitmapCanvas(1, 1);
    try {
      const blob = await bitmapCanvasToBlob(
        canvas,
        "image/webp",
        QUALITY_STEPS[0],
      );
      return blob?.type === "image/webp";
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};
