/** prompt-stash-image-preparation fallback/error cleanup */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPromptStashImagePreparationSession } from "@/lib/composer/prompt-stash-image-preparation";
import {
  encodedJpegBytesOfSize,
  encodedWebpBytesOfSize,
  pngBytesOfSize,
  STATIC_MAX,
} from "./prompt-stash-image-fixtures";
import type {
  CloseMock,
  CreateImageBitmapMock,
  DrawImageMock,
  FillRectMock,
  TestCanvas2DContext,
  TestImageBitmap,
} from "./prompt-stash-image-preparation-test-helpers";

describe("prompt-stash-image-preparation fallback/error cleanup", () => {
  describe("browser codec path", () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap;

    afterEach(() => {
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        writable: true,
        value: originalCreateImageBitmap,
      });
      vi.restoreAllMocks();
    });

    function installBrowserCodecDoubles(options: {
      readonly width: number;
      readonly height: number;
      readonly encodeBlobs: Array<Blob | null>;
      readonly webpSupported: boolean | undefined;
    }): {
      readonly close: CloseMock;
      readonly createImageBitmap: CreateImageBitmapMock;
      readonly fillRect: FillRectMock;
      readonly drawImage: DrawImageMock;
    } {
      const close: CloseMock = vi.fn<() => void>(() => undefined);
      const createImageBitmap: CreateImageBitmapMock = vi.fn(
        (
          _source: ImageBitmapSource,
          opts: ImageBitmapOptions | undefined,
        ): Promise<TestImageBitmap> => {
          expect(opts).toEqual({ imageOrientation: "from-image" });
          return Promise.resolve({
            width: options.width,
            height: options.height,
            close,
          });
        },
      );
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        writable: true,
        value: createImageBitmap,
      });

      const fillRect: FillRectMock = vi.fn(
        (_x: number, _y: number, _w: number, _h: number) => undefined,
      );
      const drawImage: DrawImageMock = vi.fn(
        (..._args: unknown[]) => undefined,
      );
      const testContext: TestCanvas2DContext = {
        fillStyle: "",
        fillRect,
        drawImage,
      };

      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
        contextId: string,
      ): TestCanvas2DContext | null => {
        if (contextId === "2d") return testContext;
        return null;
      }) as HTMLCanvasElement["getContext"]);

      let encodeIndex = 0;
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
        function mockedToBlob(
          this: HTMLCanvasElement,
          callback: BlobCallback,
          type: string | undefined,
          _quality: number | undefined,
        ): void {
          if (this.width === 1 && this.height === 1) {
            if (options.webpSupported === false) {
              callback(new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
              return;
            }
            callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
            return;
          }
          const blob = options.encodeBlobs[encodeIndex] ?? null;
          encodeIndex += 1;
          if (blob !== null && type !== undefined && blob.type !== type) {
            callback(new Blob([new Uint8Array(blob.size)], { type }));
            return;
          }
          callback(blob);
        },
      );

      return { close, createImageBitmap, fillRect, drawImage };
    }

    it("decodes with imageOrientation from-image, downscales, and cleans up bitmap/canvas", async () => {
      const source = pngBytesOfSize(STATIC_MAX + 1);
      const output = encodedWebpBytesOfSize(120);
      const { close, createImageBitmap, drawImage } =
        installBrowserCodecDoubles({
          width: 3000,
          height: 2000,
          encodeBlobs: [new Blob([output], { type: "image/webp" })],
          webpSupported: undefined,
        });

      const session = createPromptStashImagePreparationSession(undefined);
      const prepared = await session.prepare({
        bytes: source,
        fileName: "photo.png",
        declaredMimeType: "image/png",
      });

      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      const firstCall = createImageBitmap.mock.calls.at(0);
      if (firstCall === undefined) {
        throw new Error("expected createImageBitmap call");
      }
      expect(firstCall[1]).toEqual({ imageOrientation: "from-image" });
      expect(prepared.mimeType).toBe("image/webp");
      expect(prepared.fileName).toBe("photo.webp");
      expect(prepared.byteLength).toBe(output.byteLength);
      expect(close).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalled();
      const drawn = drawImage.mock.calls.at(0);
      if (drawn === undefined) throw new Error("expected drawImage call");
      expect(drawn[3]).toBe(2048);
      expect(drawn[4]).toBe(Math.round(2000 * (2048 / 3000)));
    });

    it("falls back to JPEG white-matte when WebP is unavailable in the browser codec", async () => {
      const source = pngBytesOfSize(STATIC_MAX + 1);
      const jpegOut = encodedJpegBytesOfSize(100);
      const { fillRect, close } = installBrowserCodecDoubles({
        width: 500,
        height: 400,
        webpSupported: false,
        encodeBlobs: [new Blob([jpegOut], { type: "image/jpeg" })],
      });

      const session = createPromptStashImagePreparationSession(undefined);
      const prepared = await session.prepare({
        bytes: source,
        fileName: "no-webp.png",
        declaredMimeType: "image/png",
      });

      expect(prepared.mimeType).toBe("image/jpeg");
      expect(prepared.fileName).toBe("no-webp.jpg");
      expect(fillRect).toHaveBeenCalled();
      expect(fillRect.mock.calls[0]).toEqual([0, 0, 500, 400]);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("closes the bitmap when browser encode cannot fit", async () => {
      const source = pngBytesOfSize(STATIC_MAX + 1);
      const oversized = encodedWebpBytesOfSize(STATIC_MAX + 10);
      const oversizedJpeg = encodedJpegBytesOfSize(STATIC_MAX + 10);
      const blobs: Array<Blob | null> = [];
      for (let i = 0; i < 12; i += 1) {
        blobs.push(new Blob([oversized], { type: "image/webp" }));
      }
      for (let i = 0; i < 12; i += 1) {
        blobs.push(new Blob([oversizedJpeg], { type: "image/jpeg" }));
      }
      const { close } = installBrowserCodecDoubles({
        width: 800,
        height: 600,
        encodeBlobs: blobs,
        webpSupported: undefined,
      });

      const session = createPromptStashImagePreparationSession(undefined);
      await expect(
        session.prepare({
          bytes: source,
          fileName: "unfit.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(/could not be compressed enough/);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
