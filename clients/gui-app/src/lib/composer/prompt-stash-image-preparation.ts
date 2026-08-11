import {
  canonicalImageMimeType,
  sniffImageMimeType,
  type CanonicalImageMimeType,
} from "@/lib/composer/prompt-stash-image-signature";

type ImageBytes = Uint8Array<ArrayBuffer>;

export const PROMPT_STASH_STATIC_IMAGE_MAX_BYTES = 975 * 1024;
export const PROMPT_STASH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MAX_LONGEST_EDGE = 2048;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const SCALE_STEPS = [1, 0.75, 0.55] as const;

export type { CanonicalImageMimeType };

export interface PromptStashDecodedImage {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
  readonly close: () => void;
}

export interface PromptStashImageCodec {
  readonly decode: (args: {
    readonly bytes: ImageBytes;
    readonly mimeType: CanonicalImageMimeType;
  }) => Promise<PromptStashDecodedImage>;
  readonly encode: (args: {
    readonly image: PromptStashDecodedImage;
    readonly width: number;
    readonly height: number;
    readonly mimeType: "image/webp" | "image/jpeg";
    readonly quality: number;
    readonly whiteMatte: boolean;
  }) => Promise<ImageBytes | null>;
  readonly supportsWebP: () => Promise<boolean>;
}

export interface PreparedPromptStashImage {
  readonly bytes: ImageBytes;
  readonly fileName: string;
  readonly mimeType: CanonicalImageMimeType;
  readonly byteLength: number;
}

export interface PromptStashImagePreparationSession {
  readonly prepare: (args: {
    readonly bytes: ImageBytes;
    readonly fileName: string;
    readonly declaredMimeType: string;
  }) => Promise<PreparedPromptStashImage>;
}

/**
 * Creates one capture-scoped image preparation session. The session owns the
 * WebP support probe so a prompt with several oversized images probes the
 * browser codec exactly once.
 */
export function createPromptStashImagePreparationSession(
  codec: PromptStashImageCodec | undefined,
): PromptStashImagePreparationSession {
  const selectedCodec = codec ?? browserPromptStashImageCodec;
  let webPSupport: Promise<boolean> | null = null;

  return {
    prepare: async (args) => {
      const sourceMimeType = validateSourceImage(
        args.bytes,
        args.declaredMimeType,
      );
      const preserveAnimation = isVerbatimAnimation(args.bytes, sourceMimeType);

      let decoded: PromptStashDecodedImage;
      try {
        decoded = await selectedCodec.decode({
          bytes: args.bytes,
          mimeType: sourceMimeType,
        });
      } catch {
        throw new Error("A prompt image could not be decoded.");
      }

      try {
        validateDecodedDimensions(decoded);
        if (preserveAnimation) {
          return preparedVerbatim(args.bytes, args.fileName, sourceMimeType);
        }
        if (args.bytes.byteLength <= PROMPT_STASH_STATIC_IMAGE_MAX_BYTES) {
          return preparedVerbatim(args.bytes, args.fileName, sourceMimeType);
        }

        webPSupport ??= selectedCodec.supportsWebP().catch(() => false);
        const supportsWebP = await webPSupport;
        const bounded = boundedDimensions(decoded.width, decoded.height);
        const compressed = await compressDecodedImage({
          codec: selectedCodec,
          image: decoded,
          bounded,
          supportsWebP,
        });
        if (compressed !== null) {
          return {
            bytes: compressed.bytes,
            fileName: canonicalPromptStashImageFileName(
              args.fileName,
              compressed.mimeType,
            ),
            mimeType: compressed.mimeType,
            byteLength: compressed.bytes.byteLength,
          };
        }
      } finally {
        decoded.close();
      }

      throw new Error(
        "A prompt image could not be compressed enough to stash.",
      );
    },
  };
}

function validateSourceImage(
  bytes: ImageBytes,
  declaredMimeType: string,
): CanonicalImageMimeType {
  if (bytes.byteLength === 0) {
    throw new Error("A prompt image is empty.");
  }
  if (bytes.byteLength > PROMPT_STASH_IMAGE_MAX_BYTES) {
    throw new Error("A prompt image is over the 5 MB limit.");
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

async function compressDecodedImage(args: {
  readonly codec: PromptStashImageCodec;
  readonly image: PromptStashDecodedImage;
  readonly bounded: { readonly width: number; readonly height: number };
  readonly supportsWebP: boolean;
}): Promise<{
  readonly bytes: ImageBytes;
  readonly mimeType: "image/webp" | "image/jpeg";
} | null> {
  if (args.supportsWebP) {
    const webP = await encodeWithinLimit({ ...args, mimeType: "image/webp" });
    if (webP !== null) return { bytes: webP, mimeType: "image/webp" };
  }
  const jpeg = await encodeWithinLimit({ ...args, mimeType: "image/jpeg" });
  return jpeg === null ? null : { bytes: jpeg, mimeType: "image/jpeg" };
}

async function encodeWithinLimit(args: {
  readonly codec: PromptStashImageCodec;
  readonly image: PromptStashDecodedImage;
  readonly bounded: { readonly width: number; readonly height: number };
  readonly mimeType: "image/webp" | "image/jpeg";
}): Promise<ImageBytes | null> {
  const attempts = SCALE_STEPS.flatMap((scale) =>
    QUALITY_STEPS.map((quality) => ({ scale, quality })),
  );
  for (const attempt of attempts) {
    const candidate = await tryEncodeCandidate(args, attempt);
    if (
      candidate !== null &&
      sniffImageMimeType(candidate) === args.mimeType &&
      candidate.byteLength <= PROMPT_STASH_STATIC_IMAGE_MAX_BYTES
    ) {
      return candidate;
    }
  }
  return null;
}

async function tryEncodeCandidate(
  args: {
    readonly codec: PromptStashImageCodec;
    readonly image: PromptStashDecodedImage;
    readonly bounded: { readonly width: number; readonly height: number };
    readonly mimeType: "image/webp" | "image/jpeg";
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
): PreparedPromptStashImage {
  return {
    bytes,
    fileName: canonicalPromptStashImageFileName(fileName, mimeType),
    mimeType,
    byteLength: bytes.byteLength,
  };
}

export function canonicalPromptStashImageFileName(
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

function validateDecodedDimensions(image: PromptStashDecodedImage): void {
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
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, MAX_LONGEST_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
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

function invalidImageBytes(): Error {
  return new Error("A prompt image contains invalid image data.");
}

const browserPromptStashImageCodec: PromptStashImageCodec = {
  decode: async ({ bytes, mimeType }) => {
    if (typeof createImageBitmap !== "function") {
      throw new Error("This browser cannot decode images for stashing.");
    }
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: mimeType }),
      {
        imageOrientation: "from-image",
      },
    );
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  },
  encode: async (args) => {
    const canvas = createCanvas(args.width, args.height);
    try {
      const context = canvas.getContext("2d");
      if (context === null) return null;
      if (args.whiteMatte) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, args.width, args.height);
      }
      context.drawImage(args.image.source, 0, 0, args.width, args.height);
      const blob = await canvasToBlob(canvas, args.mimeType, args.quality);
      if (blob === null || blob.type !== args.mimeType) return null;
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
  supportsWebP: async () => {
    const canvas = createCanvas(1, 1);
    try {
      const blob = await canvasToBlob(canvas, "image/webp", QUALITY_STEPS[0]);
      return blob?.type === "image/webp";
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new Error("This browser cannot encode images for stashing.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}
