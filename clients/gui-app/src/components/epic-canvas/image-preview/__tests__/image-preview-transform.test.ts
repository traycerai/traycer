import { describe, expect, it } from "vitest";
import { clampPositionToVisibleBounds } from "../image-preview-transform";

describe("clampPositionToVisibleBounds", () => {
  it("keeps the lower endpoint one pixel inside the old zero-overlap bound", () => {
    expect(clampPositionToVisibleBounds(-200, 100, 200)).toBe(-199);
  });

  it("keeps the upper endpoint one pixel inside the old zero-overlap bound", () => {
    expect(clampPositionToVisibleBounds(100, 100, 200)).toBe(99);
  });
});
