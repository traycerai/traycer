import { describe, expect, it } from "vitest";

import { terminalSelectionAnchor } from "../terminal-selection-anchor";

// A 24x100 grid of 20x10px cells, inset 8px from the pane's top and left by
// tile chrome, in a pane 1016px wide (the grid plus both insets).
const GRID = {
  rows: 24,
  cols: 100,
  screenTop: 8,
  screenHeight: 480,
  screenLeft: 8,
  screenWidth: 1000,
  paneWidth: 1016,
} as const;

// Column 20 in that grid, and the room left beside it. Most cases below are
// about the vertical axis and just hold the column still.
const LEFT_AT_COLUMN_20 = 8 + 20 * 10;
const MAX_WIDTH_AT_COLUMN_20 = 1016 - 8 - LEFT_AT_COLUMN_20;

describe("terminalSelectionAnchor", () => {
  it("sits above the first selected line", () => {
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 10,
        selectionStartColumn: 20,
        viewportY: 0,
      }),
    ).toEqual({
      top: 8 + 10 * 20 - 4,
      left: LEFT_AT_COLUMN_20,
      maxWidth: MAX_WIDTH_AT_COLUMN_20,
      placement: "above",
    });
  });

  it("flips below when the selection starts at the top of the pane", () => {
    // Nowhere to put the control above row 0, so it goes under the line
    // instead of being clipped by the tile's edge.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 0,
        selectionStartColumn: 20,
        viewportY: 0,
      }),
    ).toEqual({
      top: 8 + 20 + 4,
      left: LEFT_AT_COLUMN_20,
      maxWidth: MAX_WIDTH_AT_COLUMN_20,
      placement: "below",
    });
  });

  it("measures against the scrolled viewport, not the buffer", () => {
    // Row 1002 with 1000 rows of scrollback above it is the third visible line.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 1002,
        selectionStartColumn: 20,
        viewportY: 1000,
      }),
    ).toEqual({
      top: 8 + 2 * 20 - 4,
      left: LEFT_AT_COLUMN_20,
      maxWidth: MAX_WIDTH_AT_COLUMN_20,
      placement: "above",
    });
  });

  it("holds at the top visible line when the selection scrolls out of view", () => {
    // The user scrolled down past their own selection: anchor to the top of
    // the viewport rather than to a negative offset off-screen.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 5,
        selectionStartColumn: 20,
        viewportY: 400,
      }),
    ).toEqual({
      top: 8 + 20 + 4,
      left: LEFT_AT_COLUMN_20,
      maxWidth: MAX_WIDTH_AT_COLUMN_20,
      placement: "below",
    });
  });

  it("scales with the row height rather than assuming one", () => {
    // Same row, half the font size: the anchor halves with it.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        screenHeight: 240,
        selectionStartRow: 10,
        selectionStartColumn: 20,
        viewportY: 0,
      }),
    ).toEqual({
      top: 8 + 10 * 10 - 4,
      left: LEFT_AT_COLUMN_20,
      maxWidth: MAX_WIDTH_AT_COLUMN_20,
      placement: "above",
    });
  });

  it("tracks the selection's start column across the pane", () => {
    // The whole point of the horizontal axis: a selection two-thirds of the
    // way across a wide pane gets its control there, not back on the left rail.
    const anchor = terminalSelectionAnchor({
      ...GRID,
      selectionStartRow: 10,
      selectionStartColumn: 60,
      viewportY: 0,
    });
    expect(anchor.left).toBe(8 + 60 * 10);
    expect(anchor.maxWidth).toBe(1016 - 8 - (8 + 60 * 10));
  });

  it("scales with the cell width rather than assuming one", () => {
    // Same column, half the font size: the offset halves with it.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        screenWidth: 500,
        selectionStartRow: 10,
        selectionStartColumn: 20,
        viewportY: 0,
      }).left,
    ).toBe(8 + 20 * 5);
  });

  it("holds off the right edge so the control still fits beside it", () => {
    // Column 95 sits 958px in; placing the control there would run it off the
    // pane, so it stops with just enough room for the pill.
    const anchor = terminalSelectionAnchor({
      ...GRID,
      selectionStartRow: 10,
      selectionStartColumn: 95,
      viewportY: 0,
    });
    expect(anchor.left).toBe(1016 - 8 - 136);
    // What is left beside it is exactly the room reserved for it.
    expect(anchor.maxWidth).toBe(136);
  });

  it("holds off the left edge for a selection starting in column zero", () => {
    // The screen's own inset already clears the edge here; the clamp is what
    // guarantees it for a pane whose grid starts flush against the box.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        screenLeft: 0,
        selectionStartRow: 10,
        selectionStartColumn: 0,
        viewportY: 0,
      }).left,
    ).toBe(8);
  });

  it("stays inside the left edge of a pane too narrow for the control", () => {
    // Both bounds cross over on a 60px pane. Keeping the inset is what stops
    // the clamp from pushing the control out past the right edge instead.
    const anchor = terminalSelectionAnchor({
      ...GRID,
      cols: 6,
      screenWidth: 60,
      paneWidth: 60,
      selectionStartRow: 10,
      selectionStartColumn: 5,
      viewportY: 0,
    });
    expect(anchor.left).toBe(8);
    expect(anchor.maxWidth).toBe(60 - 8 - 8);
  });

  it("survives a pane measured before it has any rows", () => {
    expect(
      terminalSelectionAnchor({
        rows: 0,
        cols: 0,
        screenTop: 0,
        screenHeight: 0,
        screenLeft: 0,
        screenWidth: 0,
        paneWidth: 0,
        selectionStartRow: 0,
        selectionStartColumn: 0,
        viewportY: 0,
      }),
    ).toEqual({ top: 4, left: 8, maxWidth: 0, placement: "below" });
  });
});
