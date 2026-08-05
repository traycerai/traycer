import { describe, expect, it } from "vitest";

import { terminalSelectionAnchor } from "../terminal-selection-anchor";

// A 24-row grid of 20px lines, inset 8px from the pane's top by tile chrome.
const GRID = {
  rows: 24,
  screenTop: 8,
  screenHeight: 480,
} as const;

describe("terminalSelectionAnchor", () => {
  it("sits above the first selected line", () => {
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 10,
        viewportY: 0,
      }),
    ).toEqual({ top: 8 + 10 * 20 - 4, placement: "above" });
  });

  it("flips below when the selection starts at the top of the pane", () => {
    // Nowhere to put the control above row 0, so it goes under the line
    // instead of being clipped by the tile's edge.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 0,
        viewportY: 0,
      }),
    ).toEqual({ top: 8 + 20 + 4, placement: "below" });
  });

  it("measures against the scrolled viewport, not the buffer", () => {
    // Row 1002 with 1000 rows of scrollback above it is the third visible line.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 1002,
        viewportY: 1000,
      }),
    ).toEqual({ top: 8 + 2 * 20 - 4, placement: "above" });
  });

  it("holds at the top visible line when the selection scrolls out of view", () => {
    // The user scrolled down past their own selection: anchor to the top of
    // the viewport rather than to a negative offset off-screen.
    expect(
      terminalSelectionAnchor({
        ...GRID,
        selectionStartRow: 5,
        viewportY: 400,
      }),
    ).toEqual({ top: 8 + 20 + 4, placement: "below" });
  });

  it("scales with the row height rather than assuming one", () => {
    // Same row, half the font size: the anchor halves with it.
    expect(
      terminalSelectionAnchor({
        rows: 24,
        screenTop: 8,
        screenHeight: 240,
        selectionStartRow: 10,
        viewportY: 0,
      }),
    ).toEqual({ top: 8 + 10 * 10 - 4, placement: "above" });
  });

  it("survives a pane measured before it has any rows", () => {
    expect(
      terminalSelectionAnchor({
        rows: 0,
        screenTop: 0,
        screenHeight: 0,
        selectionStartRow: 0,
        viewportY: 0,
      }),
    ).toEqual({ top: 4, placement: "below" });
  });
});
