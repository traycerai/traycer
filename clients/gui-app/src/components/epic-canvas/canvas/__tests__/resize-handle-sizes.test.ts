import { describe, expect, it } from "vitest";
import {
  computeResizeHandleSizes,
  resizeHandleSizesEqual,
} from "@/components/epic-canvas/canvas/resize-handle-sizes";

function sum(sizes: ReadonlyArray<number>): number {
  return sizes.reduce((acc, size) => acc + size, 0);
}

describe("computeResizeHandleSizes", () => {
  it("redistributes only the adjacent pair on a normal drag", () => {
    const next = computeResizeHandleSizes({
      sizes: [0.5, 0.5],
      index: 0,
      deltaRatio: 0.1,
      minSize: 0.1,
    });
    expect(next[0]).toBeCloseTo(0.6, 10);
    expect(next[1]).toBeCloseTo(0.4, 10);
  });

  it("leaves non-adjacent siblings untouched", () => {
    const next = computeResizeHandleSizes({
      sizes: [0.25, 0.25, 0.5],
      index: 0,
      deltaRatio: 0.1,
      minSize: 0.1,
    });
    expect(next[0]).toBeCloseTo(0.35, 10);
    expect(next[1]).toBeCloseTo(0.15, 10);
    // The child after the pair keeps its committed fraction exactly.
    expect(next[2]).toBe(0.5);
  });

  it.each([
    { name: "negative index", index: -1 },
    { name: "index at the last child (no right neighbor)", index: 1 },
    { name: "index past the end", index: 5 },
  ])("returns the sizes unchanged for $name", ({ index }) => {
    const sizes = [0.5, 0.5];
    const next = computeResizeHandleSizes({
      sizes,
      index,
      deltaRatio: 0.2,
      minSize: 0.1,
    });
    expect(next).toEqual(sizes);
    // Defensive copy, never the caller's array.
    expect(next).not.toBe(sizes);
  });

  it("returns the sizes unchanged when the pair sums to zero", () => {
    const next = computeResizeHandleSizes({
      sizes: [0, 0, 1],
      index: 0,
      deltaRatio: 0.3,
      minSize: 0.1,
    });
    expect(next).toEqual([0, 0, 1]);
  });

  it("returns the sizes unchanged when the pair sum is negative", () => {
    const next = computeResizeHandleSizes({
      sizes: [-0.1, 0.05, 1.05],
      index: 0,
      deltaRatio: 0.3,
      minSize: 0.1,
    });
    expect(next).toEqual([-0.1, 0.05, 1.05]);
  });

  it("clamps the per-child floor to half the pair when minSize exceeds it", () => {
    // pairSize = 0.4, so the effective floor is 0.2 - both children pin at
    // half the pair no matter how far the drag goes.
    const grown = computeResizeHandleSizes({
      sizes: [0.2, 0.2, 0.6],
      index: 0,
      deltaRatio: 10,
      minSize: 0.3,
    });
    expect(grown[0]).toBeCloseTo(0.2, 10);
    expect(grown[1]).toBeCloseTo(0.2, 10);

    const shrunk = computeResizeHandleSizes({
      sizes: [0.2, 0.2, 0.6],
      index: 0,
      deltaRatio: -10,
      minSize: 0.3,
    });
    expect(shrunk[0]).toBeCloseTo(0.2, 10);
    expect(shrunk[1]).toBeCloseTo(0.2, 10);
  });

  it.each([
    { deltaRatio: 999, expectedLeft: 0.9, expectedRight: 0.1 },
    { deltaRatio: -999, expectedLeft: 0.1, expectedRight: 0.9 },
  ])(
    "pins the pair at the floor under extreme deltaRatio $deltaRatio",
    ({ deltaRatio, expectedLeft, expectedRight }) => {
      const next = computeResizeHandleSizes({
        sizes: [0.5, 0.5],
        index: 0,
        deltaRatio,
        minSize: 0.1,
      });
      expect(next[0]).toBeCloseTo(expectedLeft, 10);
      expect(next[1]).toBeCloseTo(expectedRight, 10);
    },
  );

  it.each([
    { sizes: [0.5, 0.5], index: 0, deltaRatio: 999 },
    { sizes: [0.5, 0.5], index: 0, deltaRatio: -999 },
    { sizes: [0.3, 0.3, 0.4], index: 1, deltaRatio: 123.456 },
    { sizes: [0.25, 0.25, 0.25, 0.25], index: 2, deltaRatio: -42 },
  ])(
    "preserves the total sum under extreme deltaRatio (case %#)",
    ({ sizes, index, deltaRatio }) => {
      const next = computeResizeHandleSizes({
        sizes,
        index,
        deltaRatio,
        minSize: 0.1,
      });
      expect(sum(next)).toBeCloseTo(sum(sizes), 10);
    },
  );
});

describe("resizeHandleSizesEqual", () => {
  it("compares values instead of array identity", () => {
    expect(resizeHandleSizesEqual([0.5, 0.5], [0.5, 0.5])).toBe(true);
    expect(resizeHandleSizesEqual([0.5, 0.5], [0.5001, 0.4999])).toBe(false);
  });

  it("treats tiny floating point noise as unchanged", () => {
    expect(resizeHandleSizesEqual([0.3, 0.7], [0.3 + 1e-12, 0.7 - 1e-12])).toBe(
      true,
    );
  });
});
