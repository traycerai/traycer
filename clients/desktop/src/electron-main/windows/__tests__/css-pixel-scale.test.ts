import { describe, expect, it } from "vitest";
import {
  cssBoundsToWindowDips,
  cssPixelsToWindowDips,
} from "../css-pixel-scale";

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

describe("cssBoundsToWindowDips", () => {
  it("scales a rect", () => {
    expect(
      cssBoundsToWindowDips({ x: 100, y: 40, width: 300, height: 200 }, 1.5),
    ).toEqual({ x: 150, y: 60, width: 450, height: 300 });
  });

  it("keeps adjacent tiles sharing an edge instead of rounding apart", () => {
    const left = cssBoundsToWindowDips(
      { x: 0, y: 0, width: 100.3, height: 10 },
      1.25,
    );
    const right = cssBoundsToWindowDips(
      { x: 100.3, y: 0, width: 99.7, height: 10 },
      1.25,
    );

    expect(left.x + left.width).toBe(right.x);
    expect(right.x + right.width).toBe(250);
  });

  it("never reports a negative extent", () => {
    expect(
      cssBoundsToWindowDips({ x: 10, y: 10, width: -5, height: -5 }, 2),
    ).toMatchObject({ width: 0, height: 0 });
  });
});
