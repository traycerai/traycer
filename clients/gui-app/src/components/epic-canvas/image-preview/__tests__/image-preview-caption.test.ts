import { describe, expect, it } from "vitest";
import type { FileBytesHeader } from "@/lib/files/byte-source";
import { formatByteSize } from "@/lib/format-byte-size";
import { formatImagePreviewCaption } from "../image-preview-caption";

const META: FileBytesHeader = {
  sizeBytes: 2048,
  width: 640,
  height: 480,
};

describe("image preview captions", () => {
  it("formats byte sizes at byte, kibibyte, and mebibyte boundaries", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KiB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MiB");
  });

  it("includes dimensions and size when header metadata is complete", () => {
    expect(formatImagePreviewCaption(META)).toBe("640x480 · 2.0 KiB");
  });

  it("keeps the known size when dimensions are unavailable", () => {
    expect(
      formatImagePreviewCaption({
        ...META,
        width: null,
        height: null,
      }),
    ).toBe("2.0 KiB");
  });

  it("omits the caption when metadata is absent", () => {
    expect(formatImagePreviewCaption(null)).toBeNull();
  });

  // An epic-file entry resolves to an ADDRESS, so its header carries neither
  // half (D10) - the caption is then nothing at all rather than a stray
  // separator (ticket 27 phase A3).
  it("omits the caption when the header knows neither half", () => {
    expect(
      formatImagePreviewCaption({
        width: null,
        height: null,
        sizeBytes: null,
      }),
    ).toBeNull();
  });
});
