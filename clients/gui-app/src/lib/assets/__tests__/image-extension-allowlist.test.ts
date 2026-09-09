import { describe, expect, it } from "vitest";

import {
  isImageAssetPath,
  isPdfAssetPath,
  isPreviewableAssetPath,
  isSvgAssetPath,
} from "../image-extension-allowlist";

describe("image extension allowlist", () => {
  it("routes supported extensions case-insensitively", () => {
    expect(isImageAssetPath("images/logo.PNG")).toBe(true);
    expect(isImageAssetPath("images/logo.jpg")).toBe(true);
    expect(isImageAssetPath("images/photo.jpeg")).toBe(true);
    expect(isImageAssetPath("images/animated.gif")).toBe(true);
    expect(isImageAssetPath("images/photo.webp")).toBe(true);
    expect(isImageAssetPath("images/icon.svg")).toBe(true);
  });

  it("rejects paths without an allowed image extension", () => {
    expect(isImageAssetPath("README.md")).toBe(false);
    expect(isImageAssetPath("no-extension")).toBe(false);
    expect(isImageAssetPath("images/scan.bmp")).toBe(false);
  });

  it("recognizes SVG paths case-insensitively without treating other images as SVG", () => {
    expect(isSvgAssetPath("icons/mark.svg")).toBe(true);
    expect(isSvgAssetPath("icons/mark.SVG")).toBe(true);
    expect(isSvgAssetPath("icons/mark.png")).toBe(false);
    expect(isSvgAssetPath("icons/mark")).toBe(false);
  });

  it("routes PDF paths separately from images", () => {
    expect(isPdfAssetPath("docs/report.pdf")).toBe(true);
    expect(isPdfAssetPath("docs/report.PDF")).toBe(true);
    // PDFs are NOT images - the two route to different renderers.
    expect(isImageAssetPath("docs/report.pdf")).toBe(false);
    expect(isPdfAssetPath("docs/report.pdf.txt")).toBe(false);
    expect(isPdfAssetPath("docs/report")).toBe(false);
  });

  it("treats the previewable union as images plus PDF", () => {
    expect(isPreviewableAssetPath("images/logo.png")).toBe(true);
    expect(isPreviewableAssetPath("docs/report.pdf")).toBe(true);
    expect(isPreviewableAssetPath("README.md")).toBe(false);
  });
});
