import { describe, expect, it } from "vitest";
import {
  ditherRows,
  ditherRowsPerChannel,
  type AppearanceRamp,
} from "../appearance-image-processing";

function fakeImageData(width: number, height: number, fill: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 200;
  return { width, height, data, colorSpace: "srgb" };
}

const RAMP: AppearanceRamp = [
  [0, 0, 0],
  [100, 50, 200],
  [255, 255, 255],
];

describe("ditherRows (real pixel math)", () => {
  function tonesIn(pixels: ImageData): Set<string> {
    const tones = new Set<string>();
    for (let i = 0; i < pixels.data.length; i += 4) {
      tones.add(
        `${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`,
      );
    }
    return tones;
  }

  it("paints only ramp endpoints at two levels, and forces alpha opaque", () => {
    const pixels = fakeImageData(8, 8, 64);
    ditherRows(pixels, 2, RAMP);
    for (const tone of tonesIn(pixels))
      expect(["0,0,0", "255,255,255"]).toContain(tone);
    for (let i = 3; i < pixels.data.length; i += 4)
      expect(pixels.data[i]).toBe(255);
  });

  /** A horizontal luminance gradient, so the level count is observable. */
  function gradient(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const value = Math.round((x / (width - 1)) * 255);
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 200;
      }
    }
    return { width, height, data, colorSpace: "srgb" };
  }

  it("produces more tones as the level count rises", () => {
    const two = gradient(64, 8);
    ditherRows(two, 2, RAMP);
    const eight = gradient(64, 8);
    ditherRows(eight, 8, RAMP);
    expect(tonesIn(two).size).toBe(2);
    expect(tonesIn(eight).size).toBe(8);
  });

  it("applies a genuinely spatial (not flat) threshold across one 8x8 Bayer tile", () => {
    // A flat input must still break into more than one tone: that is the
    // ordered part of ordered dithering, and a broken threshold table would
    // paint the whole tile one color.
    const pixels = fakeImageData(8, 8, 64);
    ditherRows(pixels, 4, RAMP);
    expect(tonesIn(pixels).size).toBeGreaterThan(1);
  });

  it("tiles the threshold pattern every 8 rows/columns, independent of image size", () => {
    const pixels = fakeImageData(16, 16, 64);
    ditherRows(pixels, 4, RAMP);
    const at = (x: number, y: number): number[] => {
      const offset = (y * 16 + x) * 4;
      return Array.from(pixels.data.slice(offset, offset + 4));
    };
    expect(at(0, 0)).toEqual(at(8, 8));
    expect(at(2, 1)).toEqual(at(10, 9));
  });

  it("is monotonic in luminance: a brighter flat input never darkens the tile", () => {
    const dark = fakeImageData(8, 8, 32);
    ditherRows(dark, 8, RAMP);
    const bright = fakeImageData(8, 8, 200);
    ditherRows(bright, 8, RAMP);
    for (let i = 0; i < dark.data.length; i += 4)
      expect(bright.data[i]).toBeGreaterThanOrEqual(dark.data[i]);
  });
});

describe("ditherRowsPerChannel (untinted, real pixel math)", () => {
  /** A flat, decidedly non-grey colour: each channel must survive on its own. */
  function flatColor(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = 20;
      data[offset + 1] = 120;
      data[offset + 2] = 220;
      data[offset + 3] = 90;
    }
    return { width, height, data, colorSpace: "srgb" };
  }

  it("dithers each channel around its own value and forces alpha opaque", () => {
    const pixels = flatColor(8, 8);
    ditherRowsPerChannel(pixels, 4);
    const steps = 3;
    const quantum = 255 / steps;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      // Every channel lands on one of the `levels` quantization steps, within
      // one step of where it started - so the colour is kept, not remapped.
      for (const [channel, source] of [20, 120, 220].entries()) {
        const painted = pixels.data[offset + channel];
        expect(painted % quantum).toBeLessThan(1);
        expect(Math.abs(painted - source)).toBeLessThanOrEqual(quantum);
      }
      expect(pixels.data[offset + 3]).toBe(255);
    }
    // The ramp version would flatten this to one grey per tone; this one must
    // keep the channels apart.
    expect(pixels.data[0]).not.toBe(pixels.data[2]);
  });
});
