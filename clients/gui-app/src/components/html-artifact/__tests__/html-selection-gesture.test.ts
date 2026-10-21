import { describe, expect, it } from "vitest";
import {
  isHtmlSelectionClick,
  moveHtmlSelectionGesture,
  type HtmlSelectionGesture,
} from "../html-selection-gesture";

const start: HtmlSelectionGesture = {
  pointerId: 1,
  x: 100,
  y: 100,
  dragged: false,
};

describe("html selection click rule", () => {
  it("is a click below 3 px of excursion and a drag from 3 px on", () => {
    expect(isHtmlSelectionClick(start, 1, { x: 102.9, y: 100 })).toBe(true);
    expect(isHtmlSelectionClick(start, 1, { x: 103, y: 100 })).toBe(false);
    expect(isHtmlSelectionClick(start, 1, { x: 102, y: 102 })).toBe(true);
    expect(isHtmlSelectionClick(start, 1, { x: 103, y: 103 })).toBe(false);
  });

  it("keeps a drag that returns to its origin a drag", () => {
    const moved = moveHtmlSelectionGesture(start, { x: 140, y: 100 });

    expect(isHtmlSelectionClick(moved, 1, { x: 100, y: 100 })).toBe(false);
  });
});
