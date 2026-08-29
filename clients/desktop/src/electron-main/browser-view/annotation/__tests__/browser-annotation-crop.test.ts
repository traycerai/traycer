import { describe, expect, it } from "vitest";
import type { BrowserAnnotationMarkSnapshot } from "../../../../ipc-contracts/browser-annotation-types";
import {
  ANNOTATION_CROP_PAD_CSS_PX,
  computeAnnotationCropRect,
  countAnnotationMarks,
  cropAnnotationPng,
  deliveredAnnotationCounts,
  originFromPageUrl,
} from "../browser-annotation-crop";
import type {
  BrowserViewCapturedImage,
  BrowserViewCropRect,
} from "../../browser-view-port";

const VIEWPORT_800x600 = { width: 800, height: 600 };
const UNION_INTERIOR = { x: 100, y: 80, width: 200, height: 120 };
const BOUNDS = { x: 1, y: 2, width: 10, height: 20 };

class FakeCropImage implements BrowserViewCapturedImage {
  croppedWith: BrowserViewCropRect | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly bytes: Uint8Array,
  ) {}

  getSize(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  isEmpty(): boolean {
    return this.width <= 0 || this.height <= 0 || this.bytes.byteLength === 0;
  }

  crop(rect: BrowserViewCropRect): BrowserViewCapturedImage {
    this.croppedWith = rect;
    return new FakeCropImage(rect.width, rect.height, this.bytes);
  }

  toJPEG(): Uint8Array {
    throw new Error("not used by crop tests");
  }

  toDataURL(): string {
    throw new Error("not used by crop tests");
  }

  toPNG(): Uint8Array {
    return this.bytes;
  }
}

class EmptyPngImage implements BrowserViewCapturedImage {
  getSize(): { readonly width: number; readonly height: number } {
    return { width: 800, height: 600 };
  }

  isEmpty(): boolean {
    return false;
  }

  crop(_rect: BrowserViewCropRect): BrowserViewCapturedImage {
    return this;
  }

  toJPEG(): Uint8Array {
    throw new Error("not used by crop tests");
  }

  toDataURL(): string {
    throw new Error("not used by crop tests");
  }

  toPNG(): Uint8Array {
    return new Uint8Array();
  }
}

describe("annotation crop helpers", () => {
  it("exposes the 20 CSS px product pad", () => {
    expect(ANNOTATION_CROP_PAD_CSS_PX).toBe(20);
  });

  describe("computeAnnotationCropRect", () => {
    it("pads then clamps at 1x DPR when image size matches CSS viewport", () => {
      expect(
        computeAnnotationCropRect({
          unionRect: UNION_INTERIOR,
          viewport: VIEWPORT_800x600,
          imageSize: { width: 800, height: 600 },
        }),
      ).toEqual({ x: 80, y: 60, width: 240, height: 160 });
    });

    it("applies a single scale of 2 on both axes for 2x DPR", () => {
      expect(
        computeAnnotationCropRect({
          unionRect: UNION_INTERIOR,
          viewport: VIEWPORT_800x600,
          imageSize: { width: 1600, height: 1200 },
        }),
      ).toEqual({ x: 160, y: 120, width: 480, height: 320 });
    });

    it("applies a single scale of 1.5 when image width differs from CSS width (zoom)", () => {
      expect(
        computeAnnotationCropRect({
          unionRect: UNION_INTERIOR,
          viewport: VIEWPORT_800x600,
          imageSize: { width: 1200, height: 900 },
        }),
      ).toEqual({ x: 120, y: 90, width: 360, height: 240 });
    });

    it("clamps left and top pad to 0 when the union sits at the origin", () => {
      expect(
        computeAnnotationCropRect({
          unionRect: { x: 0, y: 0, width: 10, height: 10 },
          viewport: VIEWPORT_800x600,
          imageSize: { width: 800, height: 600 },
        }),
      ).toEqual({ x: 0, y: 0, width: 30, height: 30 });
    });

    it("clamps right and bottom pad to the viewport when the union sits on the far edge", () => {
      expect(
        computeAnnotationCropRect({
          unionRect: { x: 790, y: 590, width: 20, height: 20 },
          viewport: VIEWPORT_800x600,
          imageSize: { width: 800, height: 600 },
        }),
      ).toEqual({ x: 770, y: 570, width: 30, height: 30 });
    });

    it("returns null for a zero-width viewport, an empty image, or a union outside the viewport", () => {
      expect(
        computeAnnotationCropRect({
          unionRect: UNION_INTERIOR,
          viewport: { width: 0, height: 600 },
          imageSize: { width: 800, height: 600 },
        }),
      ).toBeNull();
      expect(
        computeAnnotationCropRect({
          unionRect: UNION_INTERIOR,
          viewport: VIEWPORT_800x600,
          imageSize: { width: 0, height: 0 },
        }),
      ).toBeNull();
      expect(
        computeAnnotationCropRect({
          unionRect: { x: 900, y: 700, width: 50, height: 50 },
          viewport: VIEWPORT_800x600,
          imageSize: { width: 800, height: 600 },
        }),
      ).toBeNull();
    });
  });

  describe("cropAnnotationPng", () => {
    it("crops with the padded 1x rect and returns the png bytes", () => {
      const image = new FakeCropImage(
        800,
        600,
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(
        cropAnnotationPng(image, UNION_INTERIOR, VIEWPORT_800x600),
      ).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
      expect(image.croppedWith).toEqual({
        x: 80,
        y: 60,
        width: 240,
        height: 160,
      });
    });

    it("returns null for an empty image, an empty crop, or empty png bytes", () => {
      expect(
        cropAnnotationPng(
          new FakeCropImage(0, 0, new Uint8Array()),
          UNION_INTERIOR,
          VIEWPORT_800x600,
        ),
      ).toBeNull();
      expect(
        cropAnnotationPng(
          new FakeCropImage(800, 600, Uint8Array.from([1, 2, 3])),
          { x: 900, y: 700, width: 50, height: 50 },
          VIEWPORT_800x600,
        ),
      ).toBeNull();
      expect(
        cropAnnotationPng(
          new EmptyPngImage(),
          UNION_INTERIOR,
          VIEWPORT_800x600,
        ),
      ).toBeNull();
    });
  });

  it("counts mixed mark kinds and treats unknown kinds as strokes", () => {
    const marks: BrowserAnnotationMarkSnapshot[] = [
      { id: "e1", kind: "element", bounds: BOUNDS, selector: "button" },
      { id: "e2", kind: "element", bounds: BOUNDS, selector: "a" },
      { id: "r1", kind: "region", bounds: BOUNDS, selector: null },
      { id: "s1", kind: "stroke", bounds: BOUNDS, selector: null },
      { id: "s2", kind: "stroke", bounds: BOUNDS, selector: null },
    ];
    expect(countAnnotationMarks(marks)).toEqual({
      elements: 2,
      regions: 1,
      strokes: 2,
    });
  });

  it("reads origin from a page URL and returns empty on parse failure", () => {
    expect(originFromPageUrl("https://example.com/path?q=1")).toBe(
      "https://example.com",
    );
    expect(originFromPageUrl("http://localhost:3000/x")).toBe(
      "http://localhost:3000",
    );
    expect(originFromPageUrl("not a url")).toBe("");
  });

  it("derives delivered counts from captures, not marks, and reports budget drops", () => {
    const marks: BrowserAnnotationMarkSnapshot[] = [
      { id: "e1", kind: "element", bounds: BOUNDS, selector: "button" },
      { id: "e2", kind: "element", bounds: BOUNDS, selector: "a" },
      { id: "e3", kind: "element", bounds: BOUNDS, selector: "h1" },
      { id: "r1", kind: "region", bounds: BOUNDS, selector: null },
      { id: "s1", kind: "stroke", bounds: BOUNDS, selector: null },
    ];
    const delivered = [
      {
        selector: "button",
        tagName: "button",
        elementId: null,
        classNames: [],
        attributes: [],
        outerHtml: "<button></button>",
        outerHtmlTruncated: false,
        textPreview: null,
        ariaRole: null,
        accessibleName: null,
        boundingBox: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          top: 0,
          right: 1,
          bottom: 1,
          left: 0,
        },
        computedStyles: [],
      },
    ];
    const result = deliveredAnnotationCounts(marks, delivered);
    expect(result.counts).toEqual({
      elements: delivered.length,
      regions: 1,
      strokes: 1,
    });
    expect(result.counts.elements).toBe(delivered.length);
    expect(result.droppedElementCount).toBe(2);
    expect(
      deliveredAnnotationCounts(marks.slice(2, 3), delivered)
        .droppedElementCount,
    ).toBe(0);
  });
});
