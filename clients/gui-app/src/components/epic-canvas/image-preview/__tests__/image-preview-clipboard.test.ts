import { afterEach, describe, expect, it, vi } from "vitest";

const copyImageBlobToClipboard = vi.fn((_blob: Blob) => Promise.resolve());
vi.mock("@/lib/images/copy-image-to-clipboard", () => ({
  copyImageBlobToClipboard,
}));

const { copyImageToClipboard } = await import("../image-preview-clipboard");

function imageWithDimensions(width: number, height: number): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  return image;
}

function stubCanvasPrototype(args: {
  readonly getContext: () => {
    readonly drawImage: (...values: unknown[]) => void;
  } | null;
  readonly toBlob: (callback: BlobCallback, type: string | undefined) => void;
}): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: args.getContext,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value: args.toBlob,
  });
}

const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
const originalToBlob = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "toBlob",
);

afterEach(() => {
  if (originalGetContext !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContext,
    );
  }
  if (originalToBlob !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "toBlob",
      originalToBlob,
    );
  }
  copyImageBlobToClipboard.mockClear();
  vi.restoreAllMocks();
});

describe("copyImageToClipboard", () => {
  it("draws the natural image size and writes the encoded PNG", async () => {
    const image = imageWithDimensions(640, 480);
    const drawImage = vi.fn();
    const blob = new Blob(["png"], { type: "image/png" });
    stubCanvasPrototype({
      getContext: () => ({ drawImage }),
      toBlob: (callback, type) => {
        expect(type).toBe("image/png");
        callback(blob);
      },
    });

    await copyImageToClipboard(image);

    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 640, 480);
    expect(copyImageBlobToClipboard).toHaveBeenCalledWith(blob);
  });

  it("rejects images without decoded dimensions before creating a canvas", async () => {
    const createElement = vi.spyOn(document, "createElement");

    await expect(
      copyImageToClipboard(imageWithDimensions(0, 480)),
    ).rejects.toThrow("This image has no dimensions to copy.");
    expect(createElement).not.toHaveBeenCalledWith("canvas");
  });

  it("rejects when the browser cannot provide a 2D canvas context", async () => {
    stubCanvasPrototype({
      getContext: () => null,
      toBlob: () => {
        throw new Error("toBlob should not be reached");
      },
    });

    await expect(
      copyImageToClipboard(imageWithDimensions(1, 1)),
    ).rejects.toThrow("This browser cannot render the image to copy it.");
    expect(copyImageBlobToClipboard).not.toHaveBeenCalled();
  });

  it("rejects when canvas encoding returns no blob", async () => {
    const image = imageWithDimensions(1, 1);
    stubCanvasPrototype({
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback) => callback(null),
    });

    await expect(copyImageToClipboard(image)).rejects.toThrow(
      "This image could not be encoded to copy it.",
    );
    expect(copyImageBlobToClipboard).not.toHaveBeenCalled();
  });
});
