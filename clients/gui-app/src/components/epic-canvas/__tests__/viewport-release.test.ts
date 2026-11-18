import { describe, expect, it } from "vitest";
import { pointIsOutsideViewport } from "@/components/epic-canvas/dnd/viewport-release";

describe("pointIsOutsideViewport", () => {
  const viewport = { width: 1200, height: 800 };

  it("classifies releases beyond every viewport edge", () => {
    expect(pointIsOutsideViewport({ x: -1, y: 20 }, viewport)).toBe(true);
    expect(pointIsOutsideViewport({ x: 20, y: -1 }, viewport)).toBe(true);
    expect(pointIsOutsideViewport({ x: 1201, y: 20 }, viewport)).toBe(true);
    expect(pointIsOutsideViewport({ x: 20, y: 801 }, viewport)).toBe(true);
  });

  it("keeps points on and inside the viewport attached", () => {
    expect(pointIsOutsideViewport({ x: 0, y: 0 }, viewport)).toBe(false);
    expect(pointIsOutsideViewport({ x: 1200, y: 800 }, viewport)).toBe(false);
    expect(pointIsOutsideViewport(null, viewport)).toBe(false);
  });
});
