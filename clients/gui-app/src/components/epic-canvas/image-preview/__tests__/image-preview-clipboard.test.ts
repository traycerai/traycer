import { describe, expect, it, vi } from "vitest";
import { copyImageToClipboard } from "../image-preview-clipboard";

function imageWithDimensions(width: number, height: number): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  return image;
}

describe("copyImageToClipboard", () => {
  it("draws the natural image size and writes the encoded PNG", async () => {
    const image = imageWithDimensions(640, 480);
    const canvas = document.createElement("canvas");
    const context = { drawImage: vi.fn() };
    const blob = new Blob(["png"], { type: "image/png" });
    const createCanvas = vi.fn(() => canvas);
    const writeClipboardPng = vi.fn((_value: Blob) => Promise.resolve());
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: () => context,
    });
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback, type: string | undefined) => {
        expect(type).toBe("image/png");
        callback(blob);
      },
    });

    await copyImageToClipboard(image, { createCanvas, writeClipboardPng });

    expect(createCanvas).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 640, 480);
    expect(writeClipboardPng).toHaveBeenCalledWith(blob);
  });

  it("rejects images without decoded dimensions before creating a canvas", async () => {
    const createCanvas = vi.fn(() => document.createElement("canvas"));
    const writeClipboardPng = vi.fn((_value: Blob) => Promise.resolve());

    await expect(
      copyImageToClipboard(imageWithDimensions(0, 480), {
        createCanvas,
        writeClipboardPng,
      }),
    ).rejects.toThrow("This image has no dimensions to copy.");
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it("rejects when the browser cannot provide a 2D canvas context", async () => {
    const createCanvas = vi.fn(() => document.createElement("canvas"));
    const writeClipboardPng = vi.fn((_value: Blob) => Promise.resolve());

    await expect(
      copyImageToClipboard(imageWithDimensions(1, 1), {
        createCanvas,
        writeClipboardPng,
      }),
    ).rejects.toThrow("This browser cannot render the image to copy it.");
    expect(writeClipboardPng).not.toHaveBeenCalled();
  });

  it("rejects when canvas encoding returns no blob", async () => {
    const image = imageWithDimensions(1, 1);
    const canvas = document.createElement("canvas");
    const context = { drawImage: vi.fn() };
    const createCanvas = vi.fn(() => canvas);
    const writeClipboardPng = vi.fn((_value: Blob) => Promise.resolve());
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: () => context,
    });
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback) => callback(null),
    });

    await expect(
      copyImageToClipboard(image, { createCanvas, writeClipboardPng }),
    ).rejects.toThrow("This image could not be encoded to copy it.");
    expect(writeClipboardPng).not.toHaveBeenCalled();
  });
});
