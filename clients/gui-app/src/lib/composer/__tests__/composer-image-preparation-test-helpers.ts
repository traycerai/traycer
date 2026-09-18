/**
 * Shared mock codec helpers for the composer image-preparation suites.
 */
import { vi, type Mock } from "vitest";

import type {
  CanonicalImageMimeType,
  DecodedImage,
  EncodableImageMimeType,
  ImagePreparationCodec,
  PreparationPolicy,
} from "@/lib/composer/composer-image-preparation-session";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  encodedJpegBytesOfSize,
  encodedPngBytesOfSize,
  encodedWebpBytesOfSize,
} from "./composer-image-preparation-fixtures";

export type EncodeArgs = {
  readonly image: DecodedImage;
  readonly width: number;
  readonly height: number;
  readonly mimeType: EncodableImageMimeType;
  readonly quality: number;
  readonly whiteMatte: boolean;
};

export type DecodeArgs = {
  readonly bytes: ImageBytes;
  readonly mimeType: CanonicalImageMimeType;
};

export interface EncodeCall {
  readonly width: number;
  readonly height: number;
  readonly mimeType: EncodableImageMimeType;
  readonly quality: number;
  readonly whiteMatte: boolean;
}

export type CloseMock = Mock<() => void>;
export type SupportsWebPMock = Mock<ImagePreparationCodec["supportsWebP"]>;
export type DecodeMock = Mock<(args: DecodeArgs) => Promise<DecodedImage>>;
export type EncodeMock = Mock<(args: EncodeArgs) => Promise<ImageBytes | null>>;
export type CreateImageBitmapMock = Mock<
  (
    source: ImageBitmapSource,
    options: ImageBitmapOptions | undefined,
  ) => Promise<TestImageBitmap>
>;
export type FillRectMock = Mock<
  (x: number, y: number, w: number, h: number) => void
>;
export type DrawImageMock = Mock<(...args: unknown[]) => void>;

export interface MockCodecOptions {
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly supportsWebP: boolean | (() => Promise<boolean>) | undefined;
  readonly close: (() => void) | undefined;
  readonly encode:
    | ((args: EncodeArgs) => Promise<ImageBytes | null>)
    | undefined;
  readonly decode: ((args: DecodeArgs) => Promise<DecodedImage>) | undefined;
}

export interface MockCodecBundle {
  readonly codec: ImagePreparationCodec;
  readonly encodeCalls: EncodeCall[];
  readonly close: CloseMock;
  readonly supportsWebP: SupportsWebPMock;
  readonly decode: DecodeMock;
  readonly encode: EncodeMock;
}

export interface TestImageBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
}

export interface TestCanvas2DContext {
  fillStyle: string;
  fillRect: FillRectMock;
  drawImage: DrawImageMock;
}

export function emptyMockCodecOptions(): MockCodecOptions {
  return {
    width: undefined,
    height: undefined,
    supportsWebP: undefined,
    close: undefined,
    encode: undefined,
    decode: undefined,
  };
}

/**
 * Narrows the mock supportsWebP option to a concrete codec probe.
 * Control-flow narrowing on the union property is done via a local so TS
 * never builds `Promise<boolean | (() => Promise<boolean>)>`.
 */
export function resolveSupportsWebPImpl(
  option: boolean | (() => Promise<boolean>) | undefined,
): ImagePreparationCodec["supportsWebP"] {
  if (typeof option === "function") {
    return option;
  }
  const flag: boolean = option === undefined ? true : option;
  return () => Promise.resolve(flag);
}

export function makeDecoded(
  width: number,
  height: number,
  close: () => void,
): DecodedImage {
  const source: CanvasImageSource = document.createElement("canvas");
  return {
    width,
    height,
    source,
    close,
  };
}

export function makeMockCodec(options: MockCodecOptions): MockCodecBundle {
  const encodeCalls: EncodeCall[] = [];
  const close: CloseMock =
    options.close === undefined
      ? vi.fn<() => void>(() => undefined)
      : vi.fn<() => void>(options.close);
  const width = options.width === undefined ? 800 : options.width;
  const height = options.height === undefined ? 600 : options.height;

  const supportsWebPImpl = resolveSupportsWebPImpl(options.supportsWebP);
  const supportsWebP: SupportsWebPMock =
    vi.fn<ImagePreparationCodec["supportsWebP"]>(supportsWebPImpl);

  const decodeImpl: (args: DecodeArgs) => Promise<DecodedImage> =
    options.decode === undefined
      ? (_args: DecodeArgs) =>
          Promise.resolve(makeDecoded(width, height, close))
      : options.decode;
  const decode: DecodeMock = vi.fn(decodeImpl);

  const defaultEncode = (args: EncodeArgs): Promise<ImageBytes | null> => {
    if (args.mimeType === "image/webp") {
      return Promise.resolve(encodedWebpBytesOfSize(64));
    }
    if (args.mimeType === "image/png") {
      return Promise.resolve(encodedPngBytesOfSize(64));
    }
    return Promise.resolve(encodedJpegBytesOfSize(64));
  };
  const encodeImpl =
    options.encode === undefined ? defaultEncode : options.encode;
  const encode: EncodeMock = vi.fn((args: EncodeArgs) => {
    encodeCalls.push({
      width: args.width,
      height: args.height,
      mimeType: args.mimeType,
      quality: args.quality,
      whiteMatte: args.whiteMatte,
    });
    return encodeImpl(args);
  });

  const codec: ImagePreparationCodec = {
    decode,
    encode,
    supportsWebP,
  };

  return {
    codec,
    encodeCalls,
    close,
    supportsWebP,
    decode,
    encode,
  };
}

/**
 * A policy whose OUTPUT ceiling is below its ANIMATION ceiling.
 *
 * These were the prompt stash's numbers, and it was the only caller that had
 * them; #1979 deleted that plane, so no production policy has this shape today
 * (`PREPARED_IMAGE_POLICY` sets `byteCeiling === animationCeiling`). It is kept
 * here as a FIXTURE rather than retired with the caller, and what it preserves
 * is specifically the SPLIT.
 *
 * The verbatim-animation branch itself is not what needs this:
 * `prepared-image-policy-matrix.test.ts` drives `animated-verbatim` and the
 * over-ceiling `ImageTooLargeError` under the production policy, so that branch
 * stays covered whatever this fixture does. What only a split policy can
 * express is an animation sized BETWEEN the two ceilings - over `byteCeiling`,
 * under `animationCeiling` - which is the case that distinguishes "passed
 * through verbatim because re-encoding cannot be frame-faithful" from "small
 * enough that no policy would have re-encoded it anyway". Where the two
 * ceilings are equal that interval is empty, so the distinction is untestable
 * and a passing suite says nothing about it.
 */
export const SPLIT_CEILING_TEST_POLICY: PreparationPolicy = {
  sourceCeiling: 5 * 1024 * 1024,
  maxLongestEdge: 2048,
  byteCeiling: 975 * 1024,
  animationCeiling: 5 * 1024 * 1024,
};
