import {
  processAppearanceImage,
  type AppearanceImageRequest,
  type ProcessedAppearanceImage,
} from "./appearance-image-processing";

export type AppearanceWorkerReply =
  | { readonly result: ProcessedAppearanceImage }
  | { readonly unsupported: true }
  | { readonly error: string };

function hasWorkerCanvas(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    return (
      typeof createImageBitmap === "function" &&
      typeof canvas.convertToBlob === "function" &&
      canvas.getContext("2d") !== null
    );
  } catch {
    return false;
  }
}

self.onmessage = async (event: MessageEvent<AppearanceImageRequest>) => {
  let reply: AppearanceWorkerReply;
  try {
    reply = hasWorkerCanvas()
      ? {
          result: await processAppearanceImage(
            event.data,
            new AbortController().signal,
          ),
        }
      : { unsupported: true };
  } catch (error) {
    reply = {
      error:
        error instanceof Error ? error.message : "Image processing failed.",
    };
  }
  self.postMessage(reply);
};
