import { describe, expect, it } from "vitest";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import {
  canvasSelectionShields,
  clipCanvasBox,
  transformCanvasBox,
} from "../canvas-selection-geometry";

const VIEWPORT_WIDTH = 100;
const VIEWPORT_HEIGHT = 80;

function area(boxes: readonly CanvasBox[]): number {
  return boxes.reduce((total, box) => total + box.width * box.height, 0);
}

function covers(boxes: readonly CanvasBox[], x: number, y: number): boolean {
  return boxes.some(
    (box) =>
      x >= box.x &&
      x < box.x + box.width &&
      y >= box.y &&
      y < box.y + box.height,
  );
}

describe("transformCanvasBox", () => {
  it("scales then translates", () => {
    expect(
      transformCanvasBox(
        { x: 10, y: 20, width: 30, height: 40 },
        { x: 5, y: -5, scaleX: 2, scaleY: 0.5 },
      ),
    ).toEqual({ x: 25, y: 5, width: 60, height: 20 });
  });
});

describe("clipCanvasBox", () => {
  const viewport = { x: 0, y: 0, width: 100, height: 100 };

  it("keeps a box that is fully inside", () => {
    const box = { x: 10, y: 10, width: 20, height: 20 };
    expect(clipCanvasBox(box, viewport)).toEqual(box);
  });

  it("trims a partially overlapping box", () => {
    expect(
      clipCanvasBox({ x: 90, y: -10, width: 30, height: 30 }, viewport),
    ).toEqual({ x: 90, y: 0, width: 10, height: 20 });
  });

  it("returns null when fully outside", () => {
    expect(
      clipCanvasBox({ x: 200, y: 200, width: 10, height: 10 }, viewport),
    ).toBeNull();
  });

  it("returns null when only touching an edge", () => {
    expect(
      clipCanvasBox({ x: 100, y: 0, width: 10, height: 10 }, viewport),
    ).toBeNull();
  });
});

describe("canvasSelectionShields", () => {
  it("covers the whole viewport with one shield when nothing is selected", () => {
    expect(
      canvasSelectionShields(null, VIEWPORT_WIDTH, VIEWPORT_HEIGHT),
    ).toEqual([{ x: 0, y: 0, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }]);
  });

  it("leaves exactly the selected box open when it sits in the middle", () => {
    const box = { x: 20, y: 10, width: 30, height: 40 };
    const shields = canvasSelectionShields(
      box,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    expect(shields).toHaveLength(4);
    expect(area(shields)).toBe(VIEWPORT_WIDTH * VIEWPORT_HEIGHT - area([box]));
    expect(covers(shields, 35, 30)).toBe(false);
    expect(covers(shields, 19, 30)).toBe(true);
    expect(covers(shields, 50, 30)).toBe(true);
    expect(covers(shields, 35, 9)).toBe(true);
    expect(covers(shields, 35, 50)).toBe(true);
  });

  it("drops zero-size shields for a box in a corner", () => {
    const shields = canvasSelectionShields(
      { x: 0, y: 0, width: 30, height: 40 },
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    expect(shields).toHaveLength(2);
    expect(area(shields)).toBe(VIEWPORT_WIDTH * VIEWPORT_HEIGHT - 30 * 40);
  });

  it("clips a box that extends past the viewport", () => {
    const shields = canvasSelectionShields(
      { x: 80, y: 60, width: 50, height: 50 },
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    expect(area(shields)).toBe(VIEWPORT_WIDTH * VIEWPORT_HEIGHT - 20 * 20);
    expect(covers(shields, 90, 70)).toBe(false);
  });

  it("shields everything when the box is fully outside", () => {
    expect(
      canvasSelectionShields(
        { x: 500, y: 500, width: 10, height: 10 },
        VIEWPORT_WIDTH,
        VIEWPORT_HEIGHT,
      ),
    ).toEqual([{ x: 0, y: 0, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }]);
  });
});
