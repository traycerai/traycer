import { describe, expect, it } from "vitest";
import { cssPixelsToWindowDips } from "../css-pixel-scale";

describe("cssPixelsToWindowDips", () => {
  it("scales by the zoom factor and rounds to whole pixels", () => {
    expect(cssPixelsToWindowDips(40, 1.5)).toBe(60);
    expect(cssPixelsToWindowDips(40, 0.67)).toBe(27);
    expect(cssPixelsToWindowDips(-12, 2)).toBe(-24);
  });

  it("degrades an unusable zoom factor to 1", () => {
    expect(cssPixelsToWindowDips(40, Number.NaN)).toBe(40);
    expect(cssPixelsToWindowDips(40, 0)).toBe(40);
    expect(cssPixelsToWindowDips(40, Number.POSITIVE_INFINITY)).toBe(40);
  });
});
