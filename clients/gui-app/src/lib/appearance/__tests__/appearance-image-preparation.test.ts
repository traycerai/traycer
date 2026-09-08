import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { AppearanceWorkerReply } from "../appearance-image-worker";
import type { ProcessedAppearanceImage } from "../appearance-image-processing";

const processingMocks = vi.hoisted(() => ({
  processAppearanceImage: vi.fn(),
  validateAppearanceImage: vi.fn(),
}));

vi.mock("../appearance-image-processing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../appearance-image-processing")>();
  return {
    ...actual,
    processAppearanceImage: processingMocks.processAppearanceImage,
    validateAppearanceImage: processingMocks.validateAppearanceImage,
  };
});

import {
  appearanceContentHash,
  prepareAppearanceImage,
  runAppearanceImageProcessing,
} from "../appearance-image-preparation";

/**
 * A controllable stand-in for the real `Worker` (jsdom has none). Tests
 * drive the worker/main-thread fork in `runAppearanceImageProcessing` by
 * calling its `onmessage` directly (see `deliverWorkerReply`) instead of
 * spinning up a real worker thread - which is also why this is the seam
 * under test here, not `appearance-image-worker.ts` itself (that file only
 * ever runs inside an actual worker).
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<AppearanceWorkerReply>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();
}

interface WorkerTestEnvironment {
  readonly instances: FakeWorker[];
  readonly restore: () => void;
}

function installWorkerEnvironment(): WorkerTestEnvironment {
  const instances: FakeWorker[] = [];
  const originalWorker = globalThis.Worker;
  const originalOffscreen = globalThis.OffscreenCanvas;
  class TrackedFakeWorker extends FakeWorker {
    constructor() {
      super();
      instances.push(this);
    }
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: TrackedFakeWorker,
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    writable: true,
    value: class {},
  });
  return {
    instances,
    restore: () => {
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: originalWorker,
      });
      Object.defineProperty(globalThis, "OffscreenCanvas", {
        configurable: true,
        writable: true,
        value: originalOffscreen,
      });
    },
  };
}

/**
 * Delivers a reply to the most recently constructed `FakeWorker`.
 * `runWorker` assigns `worker.onmessage` synchronously, before calling
 * `postMessage`, all inside the *first* synchronous slice of
 * `runAppearanceImageProcessing` - so by the time that call returns its
 * pending promise, `onmessage` is already wired and this can fire it
 * directly, with no timing race to fake around.
 */
function deliverWorkerReply(
  instances: FakeWorker[],
  reply: AppearanceWorkerReply,
): void {
  const worker = instances.at(-1);
  if (worker === undefined) throw new Error("expected a constructed worker");
  worker.onmessage?.(new MessageEvent("message", { data: reply }));
}

const NORMALIZE_REQUEST = {
  kind: "normalize" as const,
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  target: "wallpaper" as const,
};

describe("appearanceContentHash", () => {
  it("hashes real bytes with SHA-256, matching an independent digest", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const hash = await appearanceContentHash(
      new Blob([bytes], { type: "image/png" }),
    );
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different content different hashes and identical content the same hash", async () => {
    const a = await appearanceContentHash(
      new Blob([new Uint8Array([1])], { type: "image/png" }),
    );
    const b = await appearanceContentHash(
      new Blob([new Uint8Array([2])], { type: "image/png" }),
    );
    const aAgain = await appearanceContentHash(
      new Blob([new Uint8Array([1])], { type: "image/png" }),
    );
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });
});

describe("runAppearanceImageProcessing worker/main-thread fork", () => {
  afterEach(() => {
    // `vi.restoreAllMocks` only restores `vi.spyOn` spies; it leaves a
    // plain hoisted `vi.fn()`'s queued mockResolvedValue/mockRejectedValue
    // in place, so an explicit reset is what actually isolates tests here.
    processingMocks.processAppearanceImage.mockReset();
    processingMocks.validateAppearanceImage.mockReset();
  });

  it("uses the main thread directly when Worker/OffscreenCanvas are unavailable", async () => {
    const expected: ProcessedAppearanceImage = {
      blob: new Blob([new Uint8Array([1])], { type: "image/webp" }),
      width: 10,
      height: 10,
    };
    processingMocks.processAppearanceImage.mockResolvedValueOnce(expected);
    const result = await runAppearanceImageProcessing(
      NORMALIZE_REQUEST,
      new AbortController().signal,
    );
    expect(result).toBe(expected);
  });

  describe("with Worker/OffscreenCanvas present", () => {
    let env: WorkerTestEnvironment;
    beforeEach(() => {
      env = installWorkerEnvironment();
    });
    afterEach(() => {
      env.restore();
    });

    it("returns the worker's result and never falls back to the main thread", async () => {
      const expected: ProcessedAppearanceImage = {
        blob: new Blob([new Uint8Array([2])], { type: "image/webp" }),
        width: 20,
        height: 20,
      };
      const promise = runAppearanceImageProcessing(
        NORMALIZE_REQUEST,
        new AbortController().signal,
      );
      deliverWorkerReply(env.instances, { result: expected });
      const result = await promise;
      expect(result).toBe(expected);
      expect(processingMocks.processAppearanceImage).not.toHaveBeenCalled();
      expect(env.instances[0]?.terminate).toHaveBeenCalledTimes(1);
    });

    it("falls back to the main thread when the worker reports itself unsupported", async () => {
      const expected: ProcessedAppearanceImage = {
        blob: new Blob([new Uint8Array([3])], { type: "image/png" }),
        width: 5,
        height: 5,
      };
      processingMocks.processAppearanceImage.mockResolvedValueOnce(expected);
      const promise = runAppearanceImageProcessing(
        NORMALIZE_REQUEST,
        new AbortController().signal,
      );
      deliverWorkerReply(env.instances, { unsupported: true });
      const result = await promise;
      expect(result).toBe(expected);
      expect(processingMocks.processAppearanceImage).toHaveBeenCalledTimes(1);
    });

    it("propagates a worker processing error without a duplicate main-thread attempt", async () => {
      const promise = runAppearanceImageProcessing(
        NORMALIZE_REQUEST,
        new AbortController().signal,
      );
      deliverWorkerReply(env.instances, { error: "decode failed" });
      await expect(promise).rejects.toThrow("decode failed");
      expect(processingMocks.processAppearanceImage).not.toHaveBeenCalled();
    });

    it("falls back to the main thread when constructing the worker itself throws", async () => {
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: class {
          constructor() {
            throw new Error("blocked by sandbox");
          }
        },
      });
      const expected: ProcessedAppearanceImage = {
        blob: new Blob([new Uint8Array([4])], { type: "image/png" }),
        width: 1,
        height: 1,
      };
      processingMocks.processAppearanceImage.mockResolvedValueOnce(expected);
      const result = await runAppearanceImageProcessing(
        NORMALIZE_REQUEST,
        new AbortController().signal,
      );
      expect(result).toBe(expected);
    });

    it("terminates the worker and rejects when the caller aborts before it replies", async () => {
      const controller = new AbortController();
      const promise = runAppearanceImageProcessing(
        NORMALIZE_REQUEST,
        controller.signal,
      );
      controller.abort(new Error("cancelled"));
      await expect(promise).rejects.toThrow("cancelled");
      expect(env.instances[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(processingMocks.processAppearanceImage).not.toHaveBeenCalled();
    });
  });
});

describe("prepareAppearanceImage", () => {
  afterEach(() => {
    // `vi.restoreAllMocks` only restores `vi.spyOn` spies; it leaves a
    // plain hoisted `vi.fn()`'s queued mockResolvedValue/mockRejectedValue
    // in place, so an explicit reset is what actually isolates tests here.
    processingMocks.processAppearanceImage.mockReset();
    processingMocks.validateAppearanceImage.mockReset();
  });

  it("rejects on invalid input without ever processing it", async () => {
    processingMocks.validateAppearanceImage.mockRejectedValueOnce(
      new Error(
        "Choose a PNG, JPEG, or WebP image with a matching file format.",
      ),
    );
    await expect(
      prepareAppearanceImage(
        { blob: NORMALIZE_REQUEST.blob, target: "wallpaper" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/matching file format/);
    expect(processingMocks.processAppearanceImage).not.toHaveBeenCalled();
  });

  it("hashes the PROCESSED bytes (not the original) and derives a content-addressed .webp path", async () => {
    processingMocks.validateAppearanceImage.mockResolvedValueOnce(undefined);
    const processedBytes = new Uint8Array([10, 20, 30]);
    processingMocks.processAppearanceImage.mockResolvedValueOnce({
      blob: new Blob([processedBytes], { type: "image/webp" }),
      width: 100,
      height: 80,
    } satisfies ProcessedAppearanceImage);

    const prepared = await prepareAppearanceImage(
      { blob: NORMALIZE_REQUEST.blob, target: "wallpaper" },
      new AbortController().signal,
    );

    const expectedHash = await appearanceContentHash(
      new Blob([processedBytes], { type: "image/webp" }),
    );
    expect(prepared.hash).toBe(expectedHash);
    expect(prepared.path).toBe(`appearance/${expectedHash}.webp`);
    expect(prepared.width).toBe(100);
    expect(prepared.height).toBe(80);
  });

  it("derives a .png path when the processed result is not WebP", async () => {
    processingMocks.validateAppearanceImage.mockResolvedValueOnce(undefined);
    processingMocks.processAppearanceImage.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
      width: 1,
      height: 1,
    } satisfies ProcessedAppearanceImage);

    const prepared = await prepareAppearanceImage(
      { blob: NORMALIZE_REQUEST.blob, target: "icon" },
      new AbortController().signal,
    );

    expect(prepared.path).toBe(`appearance/${prepared.hash}.png`);
  });

  it("never processes an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(
      prepareAppearanceImage(
        { blob: NORMALIZE_REQUEST.blob, target: "wallpaper" },
        controller.signal,
      ),
    ).rejects.toThrow("pre-aborted");
    expect(processingMocks.validateAppearanceImage).not.toHaveBeenCalled();
  });
});
