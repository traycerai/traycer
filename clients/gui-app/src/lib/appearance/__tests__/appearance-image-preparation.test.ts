import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
} from "../appearance-image-preparation";

const SOURCE_BLOB = new Blob([new Uint8Array([1, 2, 3])], {
  type: "image/png",
});

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
      prepareAppearanceImage(SOURCE_BLOB, new AbortController().signal),
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
      SOURCE_BLOB,
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
      SOURCE_BLOB,
      new AbortController().signal,
    );

    expect(prepared.path).toBe(`appearance/${prepared.hash}.png`);
  });

  it("never processes an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(
      prepareAppearanceImage(SOURCE_BLOB, controller.signal),
    ).rejects.toThrow("pre-aborted");
    expect(processingMocks.validateAppearanceImage).not.toHaveBeenCalled();
  });
});
