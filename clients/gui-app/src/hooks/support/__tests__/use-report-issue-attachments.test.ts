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

let urlCounter = 0;
const createObjectURLMock = vi.fn((): string => `blob:mock/${++urlCounter}`);
const revokeObjectURLMock = vi.fn((): void => undefined);

beforeEach(() => {
  urlCounter = 0;
  createObjectURLMock.mockClear();
  createObjectURLMock.mockImplementation(() => `blob:mock/${++urlCounter}`);
  revokeObjectURLMock.mockClear();
  URL.createObjectURL = createObjectURLMock;
  URL.revokeObjectURL = revokeObjectURLMock;
  vi.mocked(reportImagesExceedBudget).mockImplementation(
    (total: number) =>
      total + 2 * REPORT_LOG_TAIL_MAX_BYTES > TOTAL_ATTACHMENT_BUDGET_BYTES,
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
  });

  it("ignores non-image files entirely (no rejection, no add)", () => {
    const { result } = renderHook(() => useReportIssueAttachments());

    act(() => {
      result.current.addFiles([
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ]);
    });

    // addFiles returns immediately when no image/* candidates remain.
    expect(result.current.images).toHaveLength(0);
    expect(result.current.rejection).toBeNull();
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
});
