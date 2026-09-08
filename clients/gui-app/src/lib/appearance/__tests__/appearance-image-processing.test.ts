import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  MAX_APPEARANCE_ICON_BYTES,
  MAX_APPEARANCE_WALLPAPER_BYTES,
} from "@traycer/protocol/host/workspace/appearance-schemas";
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
  ditherAppearanceRows,
  processAppearanceImage,
  validateAppearanceImage,
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

describe("ditherAppearanceRows (real pixel math)", () => {
  it("leaves every channel, including alpha, byte-identical at strength 0", () => {
    const pixels = fakeImageData(4, 4, 128);
    const before = new Uint8ClampedArray(pixels.data);
    ditherAppearanceRows(pixels, 0, 0, 4);
    expect(Array.from(pixels.data)).toEqual(Array.from(before));
  });

  it("never touches the alpha channel at full strength", () => {
    const pixels = fakeImageData(4, 4, 128);
    ditherAppearanceRows(pixels, 1, 0, 4);
    for (let i = 3; i < pixels.data.length; i += 4) {
      expect(pixels.data[i]).toBe(200);
    }
  });

  it("only mutates rows within [start, end)", () => {
    const pixels = fakeImageData(4, 4, 128);
    const before = new Uint8ClampedArray(pixels.data);
    ditherAppearanceRows(pixels, 1, 1, 3);
    const rowBytes = 4 * 4;
    expect(Array.from(pixels.data.slice(0, rowBytes))).toEqual(
      Array.from(before.slice(0, rowBytes)),
    );
    expect(Array.from(pixels.data.slice(3 * rowBytes, 4 * rowBytes))).toEqual(
      Array.from(before.slice(3 * rowBytes, 4 * rowBytes)),
    );
  });

  it("applies a genuinely spatial (not flat) threshold across one 4x4 Bayer tile", () => {
    // At strength 1 (3 levels, step 127.5) a flat 128 input rounds to the
    // SAME level everywhere (127.5/128 straddles no boundary for any of the
    // 16 threshold offsets) - that would pass even with the ordered part of
    // ordered dithering broken. 64 sits close enough to the 0/127.5 boundary
    // that different Bayer offsets push it to different sides.
    const pixels = fakeImageData(4, 4, 64);
    ditherAppearanceRows(pixels, 1, 0, 4);
    const reds = new Set<number>();
    for (let i = 0; i < pixels.data.length; i += 4) reds.add(pixels.data[i]);
    expect(reds.size).toBeGreaterThan(1);
  });

  it("tiles the threshold pattern every 4 rows/columns, independent of image size", () => {
    // Positions 4 apart in x and y share the same Bayer cell, so identical
    // input there must dither identically - the modulus contract the
    // 16-row yield loop in `applyDither` relies on to resume without seams.
    const pixels = fakeImageData(8, 8, 64);
    ditherAppearanceRows(pixels, 1, 0, 8);
    const at = (x: number, y: number): number[] => {
      const offset = (y * 8 + x) * 4;
      return Array.from(pixels.data.slice(offset, offset + 4));
    };
    expect(at(0, 0)).toEqual(at(4, 4));
    expect(at(2, 1)).toEqual(at(6, 5));
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
   * its dimensions - `applyDither` reads `canvas.width`/`canvas.height`
   * back, and the cleanup-to-zero assertions below only mean something if
   * they started non-zero.
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
        {
          kind: "normalize",
          blob: blobOf(minimalGif(), "image/gif"),
          target: "wallpaper",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);
    expect(bitmapCodecMocks.decodeBitmap).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range dither strength before decoding", async () => {
    installDecode(100, 100);
    await expect(
      processAppearanceImage(
        {
          kind: "dither",
          blob: blobOf(realPng1x1(), "image/png"),
          strength: 1.5,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/between zero and one/);
    expect(bitmapCodecMocks.decodeBitmap).not.toHaveBeenCalled();
  });

  it("downscales a wallpaper to at most 2560 on its longest edge and encodes on the first attempt", async () => {
    const { close } = installDecode(5120, 2560);
    const { canvas, context } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    const encoded = blobOf(new Uint8Array([1, 2, 3]), "image/webp");
    bitmapCodecMocks.bitmapCanvasToBlob.mockResolvedValueOnce(encoded);

    const result = await processAppearanceImage(
      {
        kind: "normalize",
        blob: blobOf(realPng1x1(), "image/png"),
        target: "wallpaper",
      },
      new AbortController().signal,
    );

    expect(result.width).toBe(2560);
    expect(result.height).toBe(1280);
    expect(context.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      2560,
      1280,
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

  it("bounds an icon to 256px, and rejects a candidate over the 256 KiB icon budget even though it fits the 4 MiB wallpaper one", async () => {
    installDecode(1000, 500);
    const { canvas } = makeFakeCanvas(noCanvasOverrides());
    installCanvas(canvas);
    // Between the two budgets: a production bug that used the wallpaper
    // budget for icons would accept this on the first attempt instead.
    const tooLargeForIcon = blobOf(
      new Uint8Array(MAX_APPEARANCE_ICON_BYTES + 1024),
      "image/webp",
    );
    const fits = blobOf(new Uint8Array(10), "image/webp");
    bitmapCodecMocks.bitmapCanvasToBlob
      .mockResolvedValueOnce(tooLargeForIcon)
      .mockResolvedValueOnce(fits);

    const result = await processAppearanceImage(
      {
        kind: "normalize",
        blob: blobOf(realPng1x1(), "image/png"),
        target: "icon",
      },
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
      new Uint8Array(MAX_APPEARANCE_WALLPAPER_BYTES + 1),
      "image/webp",
    );
    const fits = blobOf(new Uint8Array(10), "image/webp");
    bitmapCodecMocks.bitmapCanvasToBlob
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(fits);

    const result = await processAppearanceImage(
      {
        kind: "normalize",
        blob: blobOf(realPng1x1(), "image/png"),
        target: "wallpaper",
      },
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
        {
          kind: "normalize",
          blob: blobOf(realPng1x1(), "image/png"),
          target: "wallpaper",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/could not be reduced/);
    expect(bitmapCodecMocks.bitmapCanvasToBlob).toHaveBeenCalledTimes(9); // 3 scales x 3 qualities
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("runs the dither pass (real pixel math) before encoding when requested", async () => {
    installDecode(4, 4);
    const initial = fakeImageData(4, 4, 64);
    const before = Uint8ClampedArray.from(initial.data);
    const { canvas, context } = makeFakeCanvas({
      getContextReturnsNull: undefined,
      imageData: initial,
    });
    installCanvas(canvas);
    bitmapCodecMocks.bitmapCanvasToBlob.mockResolvedValueOnce(
      blobOf(new Uint8Array(10), "image/webp"),
    );

    await processAppearanceImage(
      { kind: "dither", blob: blobOf(realPng1x1(), "image/png"), strength: 1 },
      new AbortController().signal,
    );

    expect(context.getImageData).toHaveBeenCalled();
    expect(context.putImageData).toHaveBeenCalledTimes(1);
    const call = context.putImageData.mock.calls.at(0);
    if (call === undefined) throw new Error("expected a putImageData call");
    // Dithering actually changed pixels, rather than a no-op passthrough.
    expect(Array.from(call[0].data)).not.toEqual(Array.from(before));
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
        {
          kind: "normalize",
          blob: blobOf(realPng1x1(), "image/png"),
          target: "wallpaper",
        },
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
        {
          kind: "normalize",
          blob: blobOf(realPng1x1(), "image/png"),
          target: "wallpaper",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unavailable in this browser/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
