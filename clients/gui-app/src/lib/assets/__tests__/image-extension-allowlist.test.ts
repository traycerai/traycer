import { describe, expect, it } from "vitest";

import {
  candidateImageMediaType,
  isImageAssetPath,
} from "../image-extension-allowlist";

describe("image extension allowlist", () => {
  it("maps supported extensions case-insensitively", () => {
    expect(candidateImageMediaType("images/logo.PNG")).toBe("image/png");
    expect(candidateImageMediaType("images/photo.jpeg")).toBe("image/jpeg");
    expect(candidateImageMediaType("images/animated.gif")).toBe("image/gif");
    expect(candidateImageMediaType("images/photo.webp")).toBe("image/webp");
    expect(candidateImageMediaType("images/icon.svg")).toBe("image/svg+xml");
  });

  it("rejects paths without an allowed image extension", () => {
    expect(candidateImageMediaType("README.md")).toBeNull();
    expect(candidateImageMediaType("no-extension")).toBeNull();
    expect(isImageAssetPath("README.md")).toBe(false);
    expect(isImageAssetPath("images/logo.jpg")).toBe(true);
  });
});
