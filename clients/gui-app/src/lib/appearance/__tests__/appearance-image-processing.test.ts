import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { MAX_APPEARANCE_ICON_BYTES } from "@traycer/protocol/host/workspace/appearance-schemas";
import {
  pngWithDeclaredDimensions,
  realJpeg1x1,
  realPng1x1,
  realWebp1x1,
} from "./appearance-image-fixtures";
import { minimalGif } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";
import {
  fakeDecodedBitmap,
  fakeImageData,
  makeFakeCanvas,
  type FakeCanvas,
  type FakeCanvasOptions,
} from "./appearance-bitmap-codec-test-helpers";

const bitmapCodecMocks = vi.hoisted(() => ({
  decodeBitmap: vi.fn(),
  createBitmapCanvas: vi.fn(),
  bitmapCanvasToBlob:
    vi.fn<
      (
        canvas: HTMLCanvasElement | OffscreenCanvas,
        mimeType: string,
        quality: number,
      ) => Promise<Blob | null>
    >(),
}));

vi.mock("@/lib/images/bitmap-codec", () => ({
  decodeBitmap: bitmapCodecMocks.decodeBitmap,
  createBitmapCanvas: bitmapCodecMocks.createBitmapCanvas,
  bitmapCanvasToBlob: bitmapCodecMocks.bitmapCanvasToBlob,
}));

import {
  APPEARANCE_INPUT_MAX_BYTES,
  ditherRows,
  ditherRowsPerChannel,
  processAppearanceImage,
  validateAppearanceImage,
  type AppearanceRamp,
} from "../appearance-image-processing";

function blobOf(bytes: Uint8Array<ArrayBuffer>, type: string): Blob {
  return new Blob([bytes], { type });
}

function noCanvasOverrides(): FakeCanvasOptions {
  return { getContextReturnsNull: undefined, imageData: undefined };
}

describe("validateAppearanceImage", () => {
  it("accepts a real PNG/JPEG/WebP whose declared type matches its sniffed bytes", async () => {
    await expect(
      validateAppearanceImage(blobOf(realPng1x1(), "image/png")),
    ).resolves.toBeUndefined();
    await expect(
      validateAppearanceImage(blobOf(realJpeg1x1(), "image/jpeg")),
    ).resolves.toBeUndefined();
    await expect(
      validateAppearanceImage(blobOf(realWebp1x1(), "image/webp")),
    ).resolves.toBeUndefined();
  });

  it("rejects a blob over the 20 MiB byte limit before touching its format", async () => {
    const oversized = new Uint8Array(APPEARANCE_INPUT_MAX_BYTES + 1);
    await expect(
      validateAppearanceImage(blobOf(oversized, "image/png")),
    ).rejects.toThrow(/20 MiB/);
  });

  it("rejects an empty blob", async () => {
    await expect(
      validateAppearanceImage(blobOf(new Uint8Array(0), "image/png")),
    ).rejects.toThrow(/20 MiB/);
  });

  it("rejects when the declared MIME type does not match the sniffed bytes", async () => {
    await expect(
      validateAppearanceImage(blobOf(realPng1x1(), "image/jpeg")),
    ).rejects.toThrow(/matching file format/);
  });

  it("rejects GIF outright even though it sniffs as a known image format", async () => {
    await expect(
      validateAppearanceImage(blobOf(minimalGif(), "image/gif")),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);
  });

  it("rejects an image whose declared dimensions exceed 50 megapixels", async () => {
    const huge = pngWithDeclaredDimensions(8000, 8000); // 64 MP
    await expect(
      validateAppearanceImage(blobOf(huge, "image/png")),
    ).rejects.toThrow(/50 megapixels/);
  });

  it("accepts an image right at the 50 megapixel boundary", async () => {
    const atLimit = pngWithDeclaredDimensions(10000, 5000); // exactly 50,000,000
    await expect(
      validateAppearanceImage(blobOf(atLimit, "image/png")),
    ).resolves.toBeUndefined();
  });
});

const RAMP: AppearanceRamp = [
  [0, 0, 0],
  [100, 50, 200],
  [255, 255, 255],
];

describe("ditherRows (real pixel math)", () => {
  function tonesIn(pixels: ImageData): Set<string> {
    const tones = new Set<string>();
    for (let i = 0; i < pixels.data.length; i += 4) {
      tones.add(
        `${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`,
      );
    }
    return tones;
  }

  it("paints only ramp endpoints at two levels, and forces alpha opaque", () => {
    const pixels = fakeImageData(8, 8, 64);
    ditherRows(pixels, 2, RAMP);
    for (const tone of tonesIn(pixels))
      expect(["0,0,0", "255,255,255"]).toContain(tone);
    for (let i = 3; i < pixels.data.length; i += 4)
      expect(pixels.data[i]).toBe(255);
  });

  /** A horizontal luminance gradient, so the level count is observable. */
  function gradient(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const value = Math.round((x / (width - 1)) * 255);
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 200;
      }
    }
    return { width, height, data, colorSpace: "srgb" };
  }

  it("produces more tones as the level count rises", () => {
    const two = gradient(64, 8);
    ditherRows(two, 2, RAMP);
    const eight = gradient(64, 8);
    ditherRows(eight, 8, RAMP);
    expect(tonesIn(two).size).toBe(2);
    expect(tonesIn(eight).size).toBe(8);
  });

  it("applies a genuinely spatial (not flat) threshold across one 8x8 Bayer tile", () => {
    // A flat input must still break into more than one tone: that is the
    // ordered part of ordered dithering, and a broken threshold table would
    // paint the whole tile one color.
    const pixels = fakeImageData(8, 8, 64);
    ditherRows(pixels, 4, RAMP);
    expect(tonesIn(pixels).size).toBeGreaterThan(1);
  });

  it("tiles the threshold pattern every 8 rows/columns, independent of image size", () => {
    const pixels = fakeImageData(16, 16, 64);
    ditherRows(pixels, 4, RAMP);
    const at = (x: number, y: number): number[] => {
      const offset = (y * 16 + x) * 4;
      return Array.from(pixels.data.slice(offset, offset + 4));
    };
    expect(at(0, 0)).toEqual(at(8, 8));
    expect(at(2, 1)).toEqual(at(10, 9));
  });

  it("is monotonic in luminance: a brighter flat input never darkens the tile", () => {
    const dark = fakeImageData(8, 8, 32);
    ditherRows(dark, 8, RAMP);
    const bright = fakeImageData(8, 8, 200);
    ditherRows(bright, 8, RAMP);
    for (let i = 0; i < dark.data.length; i += 4)
      expect(bright.data[i]).toBeGreaterThanOrEqual(dark.data[i]);
  });
});

describe("ditherRowsPerChannel (untinted, real pixel math)", () => {
  /** A flat, decidedly non-grey colour: each channel must survive on its own. */
  function flatColor(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = 20;
      data[offset + 1] = 120;
      data[offset + 2] = 220;
      data[offset + 3] = 90;
    }
    return { width, height, data, colorSpace: "srgb" };
  }

  it("dithers each channel around its own value and forces alpha opaque", () => {
    const pixels = flatColor(8, 8);
    ditherRowsPerChannel(pixels, 4);
    const steps = 3;
    const quantum = 255 / steps;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      // Every channel lands on one of the `levels` quantization steps, within
      // one step of where it started - so the colour is kept, not remapped.
      for (const [channel, source] of [20, 120, 220].entries()) {
        const painted = pixels.data[offset + channel];
        expect(painted % quantum).toBeLessThan(1);
        expect(Math.abs(painted - source)).toBeLessThanOrEqual(quantum);
      }
      expect(pixels.data[offset + 3]).toBe(255);
    }
    // The ramp version would flatten this to one grey per tone; this one must
    // keep the channels apart.
    expect(pixels.data[0]).not.toBe(pixels.data[2]);
  });
});

describe("processAppearanceImage", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  function installDecode(
    width: number,
    height: number,
  ): {
    readonly close: Mock<() => void>;
  } {
    const close = vi.fn(() => undefined);
    bitmapCodecMocks.decodeBitmap.mockResolvedValue(
      fakeDecodedBitmap(width, height, close),
    );
    return { close };
  }

  /**
   * `createBitmapCanvas` is mocked, so this is what gives the fake canvas
   * its dimensions, and the cleanup-to-zero assertions below only mean
   * something if they started non-zero.
   */
  function installCanvas(canvas: FakeCanvas): void {
    bitmapCodecMocks.createBitmapCanvas.mockImplementation(
      (width: number, height: number) => {
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
    );
  }

  it("rejects before decoding when the input itself is invalid", async () => {
    installDecode(100, 100);
    await expect(
      processAppearanceImage(
        blobOf(minimalGif(), "image/gif"),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);
    expect(bitmapCodecMocks.decodeBitmap).not.toHaveBeenCalled();
  });

  it("downscales to at most 256 on its longest edge and encodes on the first attempt", async () => {
    const { close } = installDecode(512, 256);
    const { canvas, context } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    const encoded = blobOf(new Uint8Array([1, 2, 3]), "image/webp");
    bitmapCodecMocks.bitmapCanvasToBlob.mockResolvedValueOnce(encoded);

    const result = await processAppearanceImage(
      blobOf(realPng1x1(), "image/png"),
      new AbortController().signal,
    );

    expect(result.width).toBe(256);
    expect(result.height).toBe(128);
    expect(context.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      256,
      128,
    );
    expect(bitmapCodecMocks.bitmapCanvasToBlob).toHaveBeenCalledTimes(1);
    expect(bitmapCodecMocks.bitmapCanvasToBlob).toHaveBeenCalledWith(
      canvas,
      "image/webp",
      0.9,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("rejects a candidate over the 256 KiB icon budget and retries at a lower quality", async () => {
    installDecode(1000, 500);
    const { canvas } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    const tooLargeForIcon = blobOf(
      new Uint8Array(MAX_APPEARANCE_ICON_BYTES + 1024),
      "image/webp",
    );
    const fits = blobOf(new Uint8Array(10), "image/webp");
    bitmapCodecMocks.bitmapCanvasToBlob
      .mockResolvedValueOnce(tooLargeForIcon)
      .mockResolvedValueOnce(fits);

    const result = await processAppearanceImage(
      blobOf(realPng1x1(), "image/png"),
      new AbortController().signal,
    );

    expect(Math.max(result.width, result.height)).toBe(256);
    expect(bitmapCodecMocks.bitmapCanvasToBlob).toHaveBeenCalledTimes(2);
    expect(result.blob).toBe(fits);
  });

  it("walks scale x quality combinations until one fits, then stops", async () => {
    installDecode(2560, 2560);
    const { canvas } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    const oversized = blobOf(
      new Uint8Array(MAX_APPEARANCE_ICON_BYTES + 1),
      "image/webp",
    );
    const fits = blobOf(new Uint8Array(10), "image/webp");
    bitmapCodecMocks.bitmapCanvasToBlob
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(fits);

    const result = await processAppearanceImage(
      blobOf(realPng1x1(), "image/png"),
      new AbortController().signal,
    );

    expect(bitmapCodecMocks.bitmapCanvasToBlob).toHaveBeenCalledTimes(4);
    expect(result.blob).toBe(fits);
    const qualities = bitmapCodecMocks.bitmapCanvasToBlob.mock.calls.map(
      (call) => call[2],
    );
    expect(qualities).toEqual([0.9, 0.75, 0.55, 0.9]);
  });

  it("throws once the full scale x quality ladder is exhausted, and still closes the decode", async () => {
    const { close } = installDecode(1000, 1000);
    const { canvas } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    bitmapCodecMocks.bitmapCanvasToBlob.mockResolvedValue(null);

    await expect(
      processAppearanceImage(
        blobOf(realPng1x1(), "image/png"),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/could not be reduced/);
    expect(bitmapCodecMocks.bitmapCanvasToBlob).toHaveBeenCalledTimes(9); // 3 scales x 3 qualities
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates abort raised mid-ladder and still closes the decoded bitmap", async () => {
    const { close } = installDecode(1000, 1000);
    const { canvas } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    const controller = new AbortController();
    bitmapCodecMocks.bitmapCanvasToBlob.mockImplementationOnce(() => {
      controller.abort(new Error("cancelled mid-ladder"));
      return Promise.resolve(blobOf(new Uint8Array(10), "image/webp"));
    });

    await expect(
      processAppearanceImage(
        blobOf(realPng1x1(), "image/png"),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled mid-ladder");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("surfaces the canvas-unavailable error and still closes the decoded bitmap", async () => {
    const { close } = installDecode(100, 100);
    const { canvas } = makeFakeCanvas({
      getContextReturnsNull: true,
      imageData: undefined,
    });
    installCanvas(canvas);

    await expect(
      processAppearanceImage(
        blobOf(realPng1x1(), "image/png"),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unavailable in this browser/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
