import {
  processAppearanceImage,
  validateAppearanceImage,
  type AppearanceImageRequest,
  type AppearanceImageTarget,
  type ProcessedAppearanceImage,
} from "./appearance-image-processing";
import type { AppearanceWorkerReply } from "./appearance-image-worker";

export interface PreparedAppearanceImage extends ProcessedAppearanceImage {
  readonly hash: string;
  readonly path: string;
}

export async function appearanceContentHash(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function runWorker(
  worker: Worker,
  request: AppearanceImageRequest,
  signal: AbortSignal,
): Promise<AppearanceWorkerReply> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Image processing aborted.", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<AppearanceWorkerReply>) => {
      signal.removeEventListener("abort", abort);
      resolve(event.data);
    };
    worker.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Image worker is unavailable."));
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(
        error instanceof Error
          ? error
          : new Error("Image worker is unavailable.", { cause: error }),
      );
    }
  });
}

export async function runAppearanceImageProcessing(
  request: AppearanceImageRequest,
  signal: AbortSignal,
): Promise<ProcessedAppearanceImage> {
  signal.throwIfAborted();
  if (typeof Worker === "function" && typeof OffscreenCanvas === "function") {
    let worker: Worker | null = null;
    let reply: AppearanceWorkerReply | null = null;
    try {
      worker = new Worker(
        new URL("./appearance-image-worker.ts", import.meta.url),
        { type: "module" },
      );
      reply = await runWorker(worker, request, signal);
    } catch {
      signal.throwIfAborted();
      // Sandboxed browsers can expose Worker/OffscreenCanvas but refuse their use.
    } finally {
      worker?.terminate();
    }
    if (reply !== null && !("unsupported" in reply)) {
      if ("error" in reply) throw new Error(reply.error);
      return reply.result;
    }
  }
  return processAppearanceImage(request, signal);
}

/** Always re-encode: persisted originals are static, bounded, and reversible. */
export async function prepareAppearanceImage(
  args: {
    readonly blob: Blob;
    readonly target: AppearanceImageTarget;
  },
  signal: AbortSignal,
): Promise<PreparedAppearanceImage> {
  signal.throwIfAborted();
  await validateAppearanceImage(args.blob);
  const result = await runAppearanceImageProcessing(
    { kind: "normalize", ...args },
    signal,
  );
  signal.throwIfAborted();
  const hash = await appearanceContentHash(result.blob);
  signal.throwIfAborted();
  const extension = result.blob.type === "image/webp" ? "webp" : "png";
  return { ...result, hash, path: `appearance/${hash}.${extension}` };
}
