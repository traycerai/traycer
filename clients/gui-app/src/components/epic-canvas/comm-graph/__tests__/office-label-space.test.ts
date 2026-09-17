/**
 * The one rule the whole label layer now rests on: nothing `placeOfficeLabel`
 * hands back overlaps anything it has already handed back.
 *
 * Five channels letter the office and each of them used to decide for itself
 * where its text went; they now all come through here, so a hole in this
 * module is a hole in every one of them at once. The cases below are the
 * mechanism - the renderer's own suite pins the outcome on real floors.
 */
import { describe, expect, it } from "vitest";
import {
  createLabelSpace,
  OFFICE_LABEL_FIXED,
  officeLabelBoxesOverlap,
  placeOfficeLabel,
  resetLabelSpace,
  type OfficeLabelBox,
} from "@/components/epic-canvas/comm-graph/office/office-label-space";

function box(
  left: number,
  top: number,
  width: number,
  height: number,
): OfficeLabelBox {
  return { left, right: left + width, top, bottom: top + height };
}

describe("placeOfficeLabel", () => {
  it("gives an unobstructed label exactly the box it asked for", () => {
    const space = createLabelSpace();

    expect(
      placeOfficeLabel(space, box(0, 0, 40, 10), OFFICE_LABEL_FIXED),
    ).toEqual(box(0, 0, 40, 10));
  });

  it("refuses a fixed label whose box is already taken", () => {
    const space = createLabelSpace();
    placeOfficeLabel(space, box(0, 0, 40, 10), OFFICE_LABEL_FIXED);

    // A wall plate has a board under it and cannot move, so the second one
    // is dropped rather than drawn through the first.
    expect(
      placeOfficeLabel(space, box(20, 4, 40, 10), OFFICE_LABEL_FIXED),
    ).toBeNull();
    expect(space.boxes).toHaveLength(1);
  });

  it("lifts a label that is allowed to move, and reports where it landed", () => {
    const space = createLabelSpace();
    placeOfficeLabel(space, box(0, 0, 40, 10), OFFICE_LABEL_FIXED);

    const placed = placeOfficeLabel(space, box(0, 4, 40, 10), {
      dy: -14,
      max: 2,
    });

    // One lift clears it: 4 - 14 = -10, whose 10px box ends exactly at the
    // occupant's top edge.
    expect(placed).toEqual(box(0, -10, 40, 10));
    expect(
      officeLabelBoxesOverlap(placed as OfficeLabelBox, box(0, 0, 40, 10)),
    ).toBe(false);
  });

  it("drops a movable label once its attempts are used up", () => {
    const space = createLabelSpace();
    // A wall of occupied boxes covering the anchor and both lifts.
    placeOfficeLabel(space, box(0, -40, 40, 60), OFFICE_LABEL_FIXED);

    expect(
      placeOfficeLabel(space, box(0, 4, 40, 10), { dy: -14, max: 2 }),
    ).toBeNull();
  });

  it("treats boxes that only share an edge as clear", () => {
    const space = createLabelSpace();
    placeOfficeLabel(space, box(0, 0, 40, 10), OFFICE_LABEL_FIXED);

    // Strict overlap, the same test `layoutNameTags` has always used: two
    // plates flush against each other both survive.
    expect(
      placeOfficeLabel(space, box(40, 0, 40, 10), OFFICE_LABEL_FIXED),
    ).toEqual(box(40, 0, 40, 10));
  });

  it("never returns a box overlapping one it returned earlier", () => {
    // The invariant itself, over a crowd dense enough that most of them have
    // to move or be dropped. A pass that returned its anchor regardless would
    // satisfy every case above that has only two labels in it.
    const space = createLabelSpace();
    const placed: OfficeLabelBox[] = [];
    for (let i = 0; i < 60; i += 1) {
      const result = placeOfficeLabel(space, box((i % 6) * 12, 0, 40, 10), {
        dy: 11,
        max: 2,
      });
      if (result !== null) placed.push(result);
    }

    // Some were placed and some were dropped: a run where everything fit, or
    // where nothing did, would not exercise the invariant at all.
    expect(placed.length).toBeGreaterThan(2);
    expect(placed.length).toBeLessThan(60);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        expect(officeLabelBoxesOverlap(placed[i], placed[j])).toBe(false);
      }
    }
  });

  it("forgets the previous frame when it is reset", () => {
    const space = createLabelSpace();
    placeOfficeLabel(space, box(0, 0, 40, 10), OFFICE_LABEL_FIXED);
    resetLabelSpace(space);

    // The space is per FRAME. Carrying boxes over would make the office empty
    // itself of lettering the longer it stayed open.
    expect(
      placeOfficeLabel(space, box(0, 0, 40, 10), OFFICE_LABEL_FIXED),
    ).toEqual(box(0, 0, 40, 10));
    expect(space.boxes).toHaveLength(1);
  });
});
