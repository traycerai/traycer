export interface DecodedBitmap {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
  readonly close: () => void;
}

export async function decodeBitmap(blob: Blob): Promise<DecodedBitmap> {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: "from-image",
  });
  return {
    width: bitmap.width,
    height: bitmap.height,
    source: bitmap,
    close: () => bitmap.close(),
  };
}

export function createBitmapCanvas(
  width: number,
  height: number,
): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new Error("This browser cannot encode images for stashing.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function bitmapCanvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}
