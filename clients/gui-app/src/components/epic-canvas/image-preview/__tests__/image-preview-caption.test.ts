import { describe, expect, it } from "vitest";
import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";
import {
  formatImageByteSize,
  formatImagePreviewCaption,
} from "../image-preview-caption";

const META: ImageAssetMeta = {
  mediaType: "image/png",
  sizeBytes: 2048,
  width: 640,
  height: 480,
};

describe("image preview captions", () => {
  it("formats byte sizes at byte, kibibyte, and mebibyte boundaries", () => {
    expect(formatImageByteSize(0)).toBe("0 B");
    expect(formatImageByteSize(1023)).toBe("1023 B");
    expect(formatImageByteSize(1024)).toBe("1.0 KB");
    expect(formatImageByteSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("includes dimensions and size when header metadata is complete", () => {
    expect(formatImagePreviewCaption(META)).toBe("640x480 · 2.0 KB");
  });

  it("keeps the known size when dimensions are unavailable", () => {
    expect(
      formatImagePreviewCaption({
        ...META,
        width: null,
        height: null,
      }),
    ).toBe("2.0 KB");
  });

  it("omits the caption when metadata is absent", () => {
    expect(formatImagePreviewCaption(null)).toBeNull();
  });
});
