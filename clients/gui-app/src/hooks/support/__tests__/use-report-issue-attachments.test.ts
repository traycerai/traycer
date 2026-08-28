import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  REPORT_LOG_TAIL_MAX_BYTES,
  TOTAL_ATTACHMENT_BUDGET_BYTES,
  reportImagesExceedBudget,
} from "@traycer-clients/shared/support/image-attachment-guards";
import { useReportIssueAttachments } from "../use-report-issue-attachments";

// Spyable budget predicate: with current constants (3 * 5 MiB + 2 * 512 KB
// ≈ 16 MiB < 20 MiB) a pure size-based budget rejection is unreachable, so
// the budget-rejection test below forces the predicate via this mock while
// every other test uses the real implementation.
vi.mock(
  "@traycer-clients/shared/support/image-attachment-guards",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/support/image-attachment-guards")
      >();
    return {
      ...actual,
      reportImagesExceedBudget: vi.fn(actual.reportImagesExceedBudget),
    };
  },
);

const actualReportImagesExceedBudget = (
  await vi.importActual<
    typeof import("@traycer-clients/shared/support/image-attachment-guards")
  >("@traycer-clients/shared/support/image-attachment-guards")
).reportImagesExceedBudget;

function pngBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return bytes;
}

function makePngFile(
  name: string,
  options: {
    readonly size: number | undefined;
    readonly bytes: Uint8Array<ArrayBuffer> | undefined;
  },
): File {
  const bytes = options.bytes ?? pngBytes(32);
  const file = new File([bytes], name, { type: "image/png" });
  if (options.size !== undefined) {
    Object.defineProperty(file, "size", { value: options.size });
  }
  return file;
}

function makeDefaultPngFile(name: string): File {
  return makePngFile(name, { size: undefined, bytes: undefined });
}

function makeJpegFile(name: string): File {
  const bytes = new Uint8Array(24);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return new File([bytes], name, { type: "image/jpeg" });
}

/**
 * ADV-I4 fixture: a real 8-byte PNG signature with nothing after it - a
 * screenshot cut off mid-write, or a partial drag payload. The magic-byte
 * check (and the MIME allowlist) both pass this; only an actual decode
 * attempt catches it.
 */
function makeTruncatedPngFile(name: string): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return new File([bytes], name, { type: "image/png" });
}

interface DeferredPngFile {
  readonly file: File;
  readonly resolve: () => void;
}

/**
 * A PNG `File` whose `arrayBuffer()` read stays pending until `resolve()` is
 * called - lets interleaving tests park two concurrent `ingest()` loops
 * mid-read (both past their pre-await checks, neither committed yet) and
 * then control which one's commit lands first.
 */
function makeDeferredPngFile(name: string): DeferredPngFile {
  const file = makeDefaultPngFile(name);
  const bytes = pngBytes(32);
  // Definite-assignment assertion, not a type-erasing cast: the `Promise`
  // executor below is invoked synchronously (per spec) before this function
  // returns, so `release` is always assigned before `makeDeferredPngFile`'s
  // caller can read it off the returned object.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
    await gate;
    return bytes.buffer;
  });
  return { file, resolve: release };
}

let urlCounter = 0;
const createObjectURLMock = vi.fn((): string => `blob:mock/${++urlCounter}`);
const revokeObjectURLMock = vi.fn((): void => undefined);

// jsdom implements no image decoder at all, so `createImageBitmap` is absent
// from its `globalThis` - unlike the read/write DOM APIs above, there is no
// "real" implementation to spy on here. Installed fresh via
// `Object.defineProperty` each test (same pattern the shared jsdom-polyfill
// setup file uses for `ResizeObserver`/`IntersectionObserver`), scoped to
// this file only: vitest isolates `globalThis` per test file under the
// default `pool: "forks"` configuration, so this never leaks into a sibling
// test file that mounts the report-issue dialog. Defaults to a successful
// decode; individual tests override it to simulate ADV-I4's undecodable case.
const createImageBitmapMock = vi.fn(
  (_source: File): Promise<{ close: () => void }> =>
    Promise.resolve({ close: () => undefined }),
);

beforeEach(() => {
  urlCounter = 0;
  createObjectURLMock.mockClear();
  createObjectURLMock.mockImplementation(() => `blob:mock/${++urlCounter}`);
  revokeObjectURLMock.mockClear();
  URL.createObjectURL = createObjectURLMock;
  URL.revokeObjectURL = revokeObjectURLMock;
  createImageBitmapMock.mockReset();
  createImageBitmapMock.mockImplementation(() =>
    Promise.resolve({ close: () => undefined }),
  );
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: createImageBitmapMock,
  });
  vi.mocked(reportImagesExceedBudget).mockImplementation(
    actualReportImagesExceedBudget,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useReportIssueAttachments", () => {
  it("adds a valid image and exposes it with a preview URL", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([makeDefaultPngFile("shot.png")]);
    });

    await waitFor(() => {
      expect(result.current.images).toHaveLength(1);
      expect(result.current.isIngesting).toBe(false);
    });

    expect(result.current.images[0]?.fileName).toBe("shot.png");
    expect(result.current.images[0]?.mimeType).toBe("image/png");
    expect(result.current.images[0]?.size).toBeGreaterThan(0);
    expect(result.current.images[0]?.previewUrl).toMatch(/^blob:mock\//);
    expect(result.current.canAddMore).toBe(true);
    expect(result.current.rejection).toBeNull();
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it("removes an image by id and revokes its object URL", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        makeDefaultPngFile("a.png"),
        makeJpegFile("b.jpg"),
      ]);
    });

    await waitFor(() => {
      expect(result.current.images).toHaveLength(2);
    });

    expect(result.current.images[0]?.fileName).toBe("a.png");
    const firstId = result.current.images[0]?.id;
    const previewUrl = result.current.images[0]?.previewUrl;
    expect(typeof firstId).toBe("string");
    expect(typeof previewUrl).toBe("string");
    if (typeof firstId !== "string" || typeof previewUrl !== "string") {
      throw new Error("expected first image id and previewUrl");
    }

    act(() => {
      result.current.removeImage(firstId);
    });

    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]?.fileName).toBe("b.jpg");
    expect(revokeObjectURLMock).toHaveBeenCalledWith(previewUrl);
  });

  it("revokes every preview URL on unmount", async () => {
    const { result, unmount } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        makeDefaultPngFile("a.png"),
        makeJpegFile("b.jpg"),
      ]);
    });

    await waitFor(() => {
      expect(result.current.images).toHaveLength(2);
    });
    const previewUrls = result.current.images.map((image) => image.previewUrl);

    unmount();

    for (const previewUrl of previewUrls) {
      expect(revokeObjectURLMock).toHaveBeenCalledWith(previewUrl);
    }
  });

  it("rejects a 4th image with reason count without adding it", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        makeDefaultPngFile("1.png"),
        makeDefaultPngFile("2.png"),
        makeDefaultPngFile("3.png"),
      ]);
    });
    await waitFor(() => {
      expect(result.current.images).toHaveLength(MAX_REPORT_IMAGES);
    });
    expect(result.current.canAddMore).toBe(false);

    act(() => {
      result.current.addFiles([makeDefaultPngFile("4.png")]);
    });
    await waitFor(() => {
      expect(result.current.rejection?.reason).toBe("count");
    });
    expect(result.current.images).toHaveLength(MAX_REPORT_IMAGES);
    expect(result.current.rejection?.message).toContain(
      `up to ${MAX_REPORT_IMAGES} screenshots`,
    );

    const firstImageId = result.current.images[0].id;
    act(() => {
      result.current.removeImage(firstImageId);
    });
    expect(result.current.rejection).toBeNull();
  });

  it("reports a type rejection when every dropped file is a non-image", () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ]);
    });

    expect(result.current.images).toHaveLength(0);
    expect(result.current.rejection?.reason).toBe("type");
    expect(result.current.rejection?.message).toContain(
      "PNG, JPEG, GIF, or WebP",
    );
    expect(result.current.isIngesting).toBe(false);
  });

  it("rejects unsupported image types such as image/svg+xml", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.rejection?.reason).toBe("type");
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.rejection?.message).toContain(
      "PNG, JPEG, GIF, or WebP",
    );
  });

  it("rejects a file over the 5 MB per-image size limit", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());
    const oversized = makePngFile("huge.png", {
      size: MAX_REPORT_IMAGE_BYTES + 1,
      bytes: undefined,
    });

    act(() => {
      result.current.addFiles([oversized]);
    });

    await waitFor(() => {
      expect(result.current.rejection?.reason).toBe("size");
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.rejection?.message).toContain("5 MB");
  });

  it("rejects a zero-byte image as size", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());
    const empty = makePngFile("empty.png", { size: 0, bytes: undefined });

    act(() => {
      result.current.addFiles([empty]);
    });

    await waitFor(() => {
      expect(result.current.rejection?.reason).toBe("size");
    });
    expect(result.current.images).toHaveLength(0);
  });

  it("rejects when the running total would exceed the attachment budget", async () => {
    // Explicit arithmetic under current constants:
    //   TOTAL = 20 * 1024 * 1024 = 20_971_520
    //   2 * LOG = 2 * 512_000 = 1_024_000
    //   maxFittingImageTotal = 20_971_520 - 1_024_000 = 19_947_520
    //   3 * MAX_REPORT_IMAGE_BYTES = 3 * 5_242_880 = 15_728_640
    //   15_728_640 < 19_947_520 => three real max-size images never trip budget.
    // Force the predicate so the attach-time rejection UI path is covered.
    const maxFitting =
      TOTAL_ATTACHMENT_BUDGET_BYTES - 2 * REPORT_LOG_TAIL_MAX_BYTES;
    expect(MAX_REPORT_IMAGES * MAX_REPORT_IMAGE_BYTES).toBeLessThan(maxFitting);
    expect(maxFitting).toBe(19_947_520);

    vi.mocked(reportImagesExceedBudget).mockReturnValue(true);

    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        makePngFile("a.png", {
          size: MAX_REPORT_IMAGE_BYTES,
          bytes: undefined,
        }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.rejection?.reason).toBe("budget");
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.rejection?.message).toContain("size limit");
  });

  it("allows three max-size images under the real budget predicate", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        makePngFile("a.png", {
          size: MAX_REPORT_IMAGE_BYTES,
          bytes: pngBytes(64),
        }),
        makePngFile("b.png", {
          size: MAX_REPORT_IMAGE_BYTES,
          bytes: pngBytes(64),
        }),
        makePngFile("c.png", {
          size: MAX_REPORT_IMAGE_BYTES,
          bytes: pngBytes(64),
        }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.images).toHaveLength(MAX_REPORT_IMAGES);
      expect(result.current.isIngesting).toBe(false);
    });
    expect(result.current.rejection).toBeNull();
  });

  it("surfaces read_failed when file.arrayBuffer rejects", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());
    const file = makeDefaultPngFile("broken.png");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("disk error"));

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => {
      expect(result.current.rejection?.reason).toBe("read_failed");
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.rejection?.message).toContain("Couldn't read");
  });

  it("filters a mixed list to image/* only and still ingests the images", async () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        new File(["x"], "a.txt", { type: "text/plain" }),
        makeDefaultPngFile("keep.png"),
        new File(["y"], "b.pdf", { type: "application/pdf" }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.images).toHaveLength(1);
    });
    expect(result.current.images[0]?.fileName).toBe("keep.png");
  });

  describe("concurrent addFiles interleaving", () => {
    it("keeps isIngesting true until every concurrent batch has settled", async () => {
      const { result } = renderHook(() => useReportIssueAttachments());
      const fast = makeDefaultPngFile("fast.png");
      const slow = makeDeferredPngFile("slow.png");

      // A drop (fast) and a paste (slow, still reading) land back to back.
      act(() => {
        result.current.addFiles([fast]);
        result.current.addFiles([slow.file]);
      });

      await waitFor(() => {
        expect(
          result.current.images.some((image) => image.fileName === "fast.png"),
        ).toBe(true);
      });
      // The fast batch already committed and its own loop returned, but the
      // slow batch is still mid-read - a per-loop boolean would have already
      // flipped this to false here, silently telling a submit-time consumer
      // ingestion is done while an image is still in flight.
      expect(result.current.isIngesting).toBe(true);
      expect(result.current.images).toHaveLength(1);

      act(() => {
        slow.resolve();
      });

      await waitFor(() => {
        expect(result.current.images).toHaveLength(2);
        expect(result.current.isIngesting).toBe(false);
      });
    });

    it("two concurrent batches with room for both admit each exactly once", async () => {
      const { result } = renderHook(() => useReportIssueAttachments());
      const drop = makeDeferredPngFile("drop.png");
      const paste = makeDeferredPngFile("paste.png");

      act(() => {
        result.current.addFiles([drop.file]);
        result.current.addFiles([paste.file]);
      });

      act(() => {
        drop.resolve();
        paste.resolve();
      });

      await waitFor(() => {
        expect(result.current.images).toHaveLength(2);
        expect(result.current.isIngesting).toBe(false);
      });
      expect(result.current.rejection).toBeNull();
      expect(
        result.current.images.map((image) => image.fileName).sort(),
      ).toEqual(["drop.png", "paste.png"]);
    });

    it("a paste landing mid-drop for the last slot loses the commit-time cap race, not the pre-await one", async () => {
      const { result } = renderHook(() => useReportIssueAttachments());

      act(() => {
        result.current.addFiles([
          makeDefaultPngFile("1.png"),
          makeDefaultPngFile("2.png"),
        ]);
      });
      await waitFor(() => {
        expect(result.current.images).toHaveLength(2);
      });

      // Both batches pass the pre-await count check against the SAME prior
      // count (2 < 3) before either has committed - the TOCTOU window the
      // commit-time recheck exists to close.
      const drop = makeDeferredPngFile("drop.png");
      const paste = makeDeferredPngFile("paste.png");
      act(() => {
        result.current.addFiles([drop.file]);
        result.current.addFiles([paste.file]);
      });

      // drop resolves first, so it wins the one remaining slot; paste's
      // commit-time recheck must then see the cap already reached.
      act(() => {
        drop.resolve();
        paste.resolve();
      });

      await waitFor(() => {
        expect(result.current.images).toHaveLength(MAX_REPORT_IMAGES);
        expect(result.current.isIngesting).toBe(false);
      });
      expect(
        result.current.images.some((image) => image.fileName === "drop.png"),
      ).toBe(true);
      expect(
        result.current.images.some((image) => image.fileName === "paste.png"),
      ).toBe(false);
      // Commit-time drop surfaces the same honest copy as an attach-time one -
      // never a silently swallowed rejection.
      expect(result.current.rejection?.reason).toBe("count");
      expect(result.current.rejection?.message).toBe(
        `You can attach up to ${MAX_REPORT_IMAGES} screenshots.`,
      );
    });
  });

  describe("decodability (ADV-I4)", () => {
    it("rejects a truncated PNG with a valid magic prefix as corrupt, not silently attached", async () => {
      const { result } = renderHook(() => useReportIssueAttachments());
      const truncated = makeTruncatedPngFile("broken.png");
      createImageBitmapMock.mockRejectedValueOnce(
        new Error("The source image could not be decoded"),
      );

      act(() => {
        result.current.addFiles([truncated]);
      });

      await waitFor(() => {
        expect(result.current.rejection?.reason).toBe("corrupt");
      });
      expect(result.current.images).toHaveLength(0);
      expect(result.current.rejection?.message).toBe(
        "broken.png appears to be corrupted and can't be attached.",
      );
      // The rejection must not leave ingestion stuck open.
      expect(result.current.isIngesting).toBe(false);
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    });

    it("still accepts a tiny valid PNG that decodes successfully", async () => {
      const { result } = renderHook(() => useReportIssueAttachments());

      act(() => {
        result.current.addFiles([makeDefaultPngFile("tiny.png")]);
      });

      await waitFor(() => {
        expect(result.current.images).toHaveLength(1);
      });
      expect(result.current.images[0]?.fileName).toBe("tiny.png");
      expect(result.current.rejection).toBeNull();
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    });

    it("a corrupt-image rejection in one concurrent batch still lets isIngesting settle once every batch is done", async () => {
      const { result } = renderHook(() => useReportIssueAttachments());
      const slow = makeDefaultPngFile("slow.png");
      const corrupt = makeTruncatedPngFile("broken.png");

      // Gate each file's DECODE step individually (rather than relying on
      // the relative speed of a default-successful decode vs. a rejected
      // one, which is not a reliable ordering signal) so which batch is
      // still "in flight" when the assertion below runs is explicit and
      // deterministic, not inferred from microtask-hop counts.
      let releaseSlowDecode!: () => void;
      const slowDecodeGate = new Promise<void>((resolve) => {
        releaseSlowDecode = resolve;
      });
      createImageBitmapMock.mockImplementation(async (source: File) => {
        if (source === slow) await slowDecodeGate;
        if (source === corrupt) throw new Error("decode failed");
        return { close: () => undefined };
      });

      act(() => {
        result.current.addFiles([slow]);
        result.current.addFiles([corrupt]);
      });

      await waitFor(() => {
        expect(result.current.rejection?.reason).toBe("corrupt");
      });
      // The corrupt batch's own loop has already unwound through its
      // try/finally (the pending-ingest counter went 2 -> 1), but the slow
      // batch's decode is still gated - isIngesting must still reflect that
      // outstanding batch, not the corrupt one's own local completion (i.e.
      // the counter, not a per-loop boolean, survived the throw correctly).
      expect(result.current.isIngesting).toBe(true);
      expect(result.current.images).toHaveLength(0);

      act(() => {
        releaseSlowDecode();
      });

      await waitFor(() => {
        expect(result.current.images).toHaveLength(1);
        expect(result.current.isIngesting).toBe(false);
      });
      expect(result.current.images[0]?.fileName).toBe("slow.png");
    });
  });
});
