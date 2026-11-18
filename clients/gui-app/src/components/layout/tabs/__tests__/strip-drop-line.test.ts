import { describe, expect, it } from "vitest";
import {
  blockDropEdge,
  rowDropSide,
  stripDropLine,
  tabDropSide,
  type StripDropLine,
} from "../strip-drop-line";

const row = (index: number, side: "before" | "after"): StripDropLine => ({
  kind: "row",
  index,
  side,
});

describe("stripDropLine", () => {
  it("sits between two rows of one group, inside its block", () => {
    expect(stripDropLine([null, "g", "g", null], 2, "g", null)).toEqual(
      row(2, "before"),
    );
  });

  it("sits on the group's side of its end edge when the drop joins, and past it when it does not", () => {
    const groups = [null, "g", "g", null];
    expect(stripDropLine(groups, 3, "g", null)).toEqual(row(2, "after"));
    expect(stripDropLine(groups, 3, null, null)).toEqual(row(3, "before"));
  });

  it("sits on the group's side of its start edge when the drop joins, and before it when it does not", () => {
    const groups = [null, "g", "g", null];
    expect(stripDropLine(groups, 1, "g", null)).toEqual(row(1, "before"));
    expect(stripDropLine(groups, 1, null, null)).toEqual(row(0, "after"));
  });

  it("sits on the block's own outer edge where the group ends the strip and the drop leaves it", () => {
    expect(stripDropLine([null, "g", "g"], 3, null, null)).toEqual({
      kind: "block",
      groupId: "g",
      index: 2,
      edge: "bottom",
    });
    expect(stripDropLine(["g", "g", null], 0, null, null)).toEqual({
      kind: "block",
      groupId: "g",
      index: 0,
      edge: "top",
    });
    expect(stripDropLine([null, "g", "g"], 3, "g", null)).toEqual(
      row(2, "after"),
    );
  });

  it("tells the block between two groups from either group", () => {
    const groups = ["g", "h"];
    expect(stripDropLine(groups, 1, "g", null)).toEqual(row(0, "after"));
    expect(stripDropLine(groups, 1, "h", null)).toEqual(row(1, "before"));
    expect(stripDropLine(groups, 1, null, null)).toEqual({
      kind: "block",
      groupId: "g",
      index: 0,
      edge: "bottom",
    });
  });

  it("places the line against the rows around the dragged row, not against the dragged row", () => {
    // The dragged row (index 2, ungrouped) stays where it is, over the end of
    // group g: the drop joins it, so the line is on g's last row. Counted with
    // the dragged row, the rows beside the drop would both be ungrouped.
    expect(stripDropLine([null, "g", null, null], 3, "g", 2)).toEqual(
      row(1, "after"),
    );
    // The dragged row is the group's first, and the drop is just after it.
    expect(stripDropLine(["g", "g", null], 1, "g", 0)).toEqual(
      row(1, "before"),
    );
  });

  it("draws nothing without a drop or a row to carry it", () => {
    expect(stripDropLine(["g"], null, "g", null)).toBeNull();
    expect(stripDropLine(["g"], 1, "g", 0)).toBeNull();
  });

  it("is read by the row it is on, the block it is outside of, and a strip with no blocks", () => {
    const block = stripDropLine([null, "g", "g"], 3, null, null);
    expect(rowDropSide(block, 2)).toBeNull();
    expect(blockDropEdge(block, "g")).toBe("bottom");
    expect(blockDropEdge(block, "h")).toBeNull();
    expect(tabDropSide(block, 2)).toBe("after");
    expect(tabDropSide(block, 1)).toBeNull();
    expect(rowDropSide(row(2, "before"), 2)).toBe("before");
  });
});
