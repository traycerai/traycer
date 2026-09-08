/**
 * Fakes for the three `@/lib/images/bitmap-codec` primitives that
 * `appearance-image-processing.ts` calls directly (no injectable codec
 * exists at that layer, unlike the prompt-stash session). Mocking exactly
 * these three - not `HTMLCanvasElement.prototype`/`createImageBitmap` - keeps
 * the real `image-size`/signature-sniff validation pipeline in the loop while
 * removing only what jsdom cannot do (real canvas pixels/encoding).
 */
import { vi, type Mock } from "vitest";
import type { DecodedBitmap } from "@/lib/images/bitmap-codec";

export interface FakeCanvas2DContext {
  readonly drawImage: Mock<(...args: unknown[]) => void>;
  readonly getImageData: Mock<
    (x: number, y: number, w: number, h: number) => ImageData
  >;
  readonly putImageData: Mock<
    (pixels: ImageData, x: number, y: number) => void
  >;
}

export interface FakeCanvas {
  width: number;
  height: number;
  readonly getContext: Mock<(id: string) => FakeCanvas2DContext | null>;
}

export function fakeImageData(
  width: number,
  height: number,
  fill: number,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 200; // alpha, distinct from the fill
  return { width, height, data, colorSpace: "srgb" };
}

export interface FakeCanvasOptions {
  readonly getContextReturnsNull: boolean | undefined;
  readonly imageData: ImageData | undefined;
}

export function makeFakeCanvas(options: FakeCanvasOptions): {
  readonly canvas: FakeCanvas;
  readonly context: FakeCanvas2DContext;
} {
  let stored: ImageData | undefined = options.imageData;
  const context: FakeCanvas2DContext = {
    drawImage: vi.fn((..._args: unknown[]) => undefined),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      return stored ?? fakeImageData(w, h, 128);
    }),
    putImageData: vi.fn((pixels: ImageData, _x: number, _y: number) => {
      stored = pixels;
    }),
  };
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn((_id: string) =>
      options.getContextReturnsNull === true ? null : context,
    ),
  };
  return { canvas, context };
}

export function fakeDecodedBitmap(
  width: number,
  height: number,
  close: () => void,
): DecodedBitmap {
  return { width, height, source: document.createElement("canvas"), close };
}
