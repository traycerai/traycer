import { describe, expect, it } from "vitest";

import { isImageAssetPath, isSvgAssetPath } from "../image-extension-allowlist";

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
});
