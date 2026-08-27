/**
 * Shared mock codec helpers for prompt-stash-image-preparation split suites.
 */
import { vi, type Mock } from "vitest";

import type {
  CanonicalImageMimeType,
  PromptStashDecodedImage,
  PromptStashImageCodec,
} from "@/lib/composer/prompt-stash-image-preparation";
import {
  encodedJpegBytesOfSize,
  encodedWebpBytesOfSize,
} from "./prompt-stash-image-fixtures";

export type ImageBytes = Uint8Array<ArrayBuffer>;

export type EncodeArgs = {
  readonly image: PromptStashDecodedImage;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/webp" | "image/jpeg";
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
  readonly mimeType: "image/webp" | "image/jpeg";
  readonly quality: number;
  readonly whiteMatte: boolean;
}

export type CloseMock = Mock<() => void>;
export type SupportsWebPMock = Mock<PromptStashImageCodec["supportsWebP"]>;
export type DecodeMock = Mock<
  (args: DecodeArgs) => Promise<PromptStashDecodedImage>
>;
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
  readonly decode:
    | ((args: DecodeArgs) => Promise<PromptStashDecodedImage>)
    | undefined;
}

export interface MockCodecBundle {
  readonly codec: PromptStashImageCodec;
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
): PromptStashImageCodec["supportsWebP"] {
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
): PromptStashDecodedImage {
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
    vi.fn<PromptStashImageCodec["supportsWebP"]>(supportsWebPImpl);

  const decodeImpl: (args: DecodeArgs) => Promise<PromptStashDecodedImage> =
    options.decode === undefined
      ? (_args: DecodeArgs) =>
          Promise.resolve(makeDecoded(width, height, close))
      : options.decode;
  const decode: DecodeMock = vi.fn(decodeImpl);

  const defaultEncode = (args: EncodeArgs): Promise<ImageBytes | null> => {
    if (args.mimeType === "image/webp") {
      return Promise.resolve(encodedWebpBytesOfSize(64));
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

  const codec: PromptStashImageCodec = {
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
