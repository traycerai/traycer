import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  REPORT_LOG_TAIL_MAX_BYTES,
  TOTAL_ATTACHMENT_BUDGET_BYTES,
  matchesReportImageMagicBytes,
  reportImageMediaTypeForMimeType,
  reportImagesExceedBudget,
} from "../image-attachment-guards";

/** Minimal valid PNG header + padding (magic only needs first 4 bytes). */
function pngBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return bytes;
}

/** Minimal valid JPEG SOI + padding (magic needs first 3 bytes). */
function jpegBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

/** Minimal valid GIF header + padding (magic needs first 4 bytes). */
function gifBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x47;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x38;
  return bytes;
}

/** Minimal valid WEBP (RIFF....WEBP) - needs at least 12 bytes. */
function webpBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(length, 12));
  bytes[0] = 0x52;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x46;
  // bytes 4-7: chunk size (leave zero)
  bytes[8] = 0x57;
  bytes[9] = 0x45;
  bytes[10] = 0x42;
  bytes[11] = 0x50;
  return bytes;
}

const PNG = (): Uint8Array => pngBytes(24);
const JPEG = (): Uint8Array => jpegBytes(24);
const GIF = (): Uint8Array => gifBytes(24);
const WEBP = (): Uint8Array => webpBytes(24);

describe("reportImageMediaTypeForMimeType", () => {
  it.each([
    ["image/png", "image/png"],
    ["image/jpeg", "image/jpeg"],
    ["image/jpg", "image/jpeg"],
    ["image/gif", "image/gif"],
    ["image/webp", "image/webp"],
  ] as const)("maps %s -> %s", (mime, expected) => {
    expect(reportImageMediaTypeForMimeType(mime)).toBe(expected);
  });

  it.each(["IMAGE/PNG", "Image/Jpeg", "IMAGE/JPG", "image/GIF", "IMAGE/WEBP"])(
    "is case-insensitive for %s",
    (mime) => {
      expect(reportImageMediaTypeForMimeType(mime)).not.toBeNull();
    },
  );

  it.each([
    "image/svg+xml",
    "image/bmp",
    "image/avif",
    "application/octet-stream",
    "text/plain",
    "",
  ])("returns null for unsupported MIME %s", (mime) => {
    expect(reportImageMediaTypeForMimeType(mime)).toBeNull();
  });
});

describe("matchesReportImageMagicBytes", () => {
  it.each([
    { mediaType: "image/png" as const, bytes: PNG() },
    { mediaType: "image/jpeg" as const, bytes: JPEG() },
    { mediaType: "image/gif" as const, bytes: GIF() },
    { mediaType: "image/webp" as const, bytes: WEBP() },
  ])("accepts valid $mediaType magic bytes", ({ mediaType, bytes }) => {
    expect(matchesReportImageMagicBytes(bytes, mediaType)).toBe(true);
  });

  it("rejects buffers shorter than 4 bytes for every media type", () => {
    const short = new Uint8Array([0x89, 0x50, 0x4e]);
    for (const mediaType of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ] as const) {
      expect(matchesReportImageMagicBytes(short, mediaType)).toBe(false);
    }
  });

  it("rejects empty buffers", () => {
    expect(matchesReportImageMagicBytes(new Uint8Array(0), "image/png")).toBe(
      false,
    );
  });

  it("rejects mismatched magic for a declared type", () => {
    // PNG bytes declared as JPEG
    expect(matchesReportImageMagicBytes(PNG(), "image/jpeg")).toBe(false);
    // JPEG bytes declared as PNG
    expect(matchesReportImageMagicBytes(JPEG(), "image/png")).toBe(false);
    // GIF bytes declared as WEBP
    expect(matchesReportImageMagicBytes(GIF(), "image/webp")).toBe(false);
  });

  it("requires at least 12 bytes for WEBP (RIFF....WEBP)", () => {
    // 11-byte buffer with a valid RIFF prefix still fails the length gate
    const tooShort = webpBytes(12).subarray(0, 11);
    expect(tooShort.length).toBe(11);
    expect(matchesReportImageMagicBytes(tooShort, "image/webp")).toBe(false);

    // Exactly 12 bytes with correct RIFF....WEBP is enough
    expect(matchesReportImageMagicBytes(webpBytes(12), "image/webp")).toBe(
      true,
    );
  });

  it("rejects WEBP with wrong fourcc after the RIFF header", () => {
    const bytes = WEBP();
    bytes[8] = 0x00; // corrupt WEBP fourcc
    expect(matchesReportImageMagicBytes(bytes, "image/webp")).toBe(false);
  });
});

describe("reportImagesExceedBudget", () => {
  // Budget: imageBytesTotal + 2 * REPORT_LOG_TAIL_MAX_BYTES > TOTAL
  // Max image total that still fits:
  //   TOTAL - 2 * LOG = 20*1024*1024 - 2*512_000 = 19_947_520
  const maxFittingImageTotal =
    TOTAL_ATTACHMENT_BUDGET_BYTES - 2 * REPORT_LOG_TAIL_MAX_BYTES;

  it("returns false for zero images", () => {
    expect(reportImagesExceedBudget(0)).toBe(false);
  });

  it("returns false when image total is exactly at the budget boundary", () => {
    // imageTotal + 2*LOG === TOTAL  =>  NOT greater than TOTAL  =>  false
    expect(maxFittingImageTotal).toBe(19_947_520);
    expect(maxFittingImageTotal + 2 * REPORT_LOG_TAIL_MAX_BYTES).toBe(
      TOTAL_ATTACHMENT_BUDGET_BYTES,
    );
    expect(reportImagesExceedBudget(maxFittingImageTotal)).toBe(false);
  });

  it("returns true when image total is one byte over the budget boundary", () => {
    expect(reportImagesExceedBudget(maxFittingImageTotal + 1)).toBe(true);
  });

  it("returns false for the maximum realistic attach total (3 x 5 MiB)", () => {
    // Documented headroom: 3 * 5 MiB + 2 * 512 KB ≈ 16 MiB < 20 MiB.
    const threeMaxImages = MAX_REPORT_IMAGES * MAX_REPORT_IMAGE_BYTES;
    expect(threeMaxImages).toBe(15_728_640);
    expect(threeMaxImages).toBeLessThan(maxFittingImageTotal);
    expect(reportImagesExceedBudget(threeMaxImages)).toBe(false);
  });
});
