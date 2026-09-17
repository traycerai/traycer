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
  OFFICE_LABEL_HALO_PX,
  officeLabelBoxesOverlap,
  officeScreenLabelBaseline,
  officeScreenLabelBox,
  officeScreenLabelLineHeight,
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

  it("keeps two lifted labels' outlines off each other", () => {
    // WHY THE STEP IS THE BOX'S HEIGHT, end to end rather than as arithmetic.
    // A lift lands a box EXACTLY flush with the one it moved away from, and
    // edge-touching is clear by the rule above - so if the reserved box were
    // the glyph run alone, "resolved" would mean two outlines sharing two rows
    // of pixels. Both labels here are placed, and what is asserted is that
    // what they PAINT stays apart.
    const space = createLabelSpace();
    const fontPx = 10;
    const first = placeOfficeLabel(
      space,
      officeScreenLabelBox({ centerX: 100, baselineY: 50, width: 40, fontPx }),
      OFFICE_LABEL_FIXED,
    ) as OfficeLabelBox;
    const second = placeOfficeLabel(
      space,
      officeScreenLabelBox({ centerX: 100, baselineY: 50, width: 40, fontPx }),
      { dy: officeScreenLabelLineHeight(fontPx), max: 1 },
    ) as OfficeLabelBox;

    expect(second).not.toBeNull();
    const gap =
      officeScreenLabelBaseline(second) - officeScreenLabelBaseline(first);
    // MORE than the face's own height, and that strict `>` is the whole
    // assertion: a step of exactly `fontPx` is what stacking the glyph runs
    // alone would give, and it is what this produced before the outline was
    // counted. The exact figure follows, so a step that grew for some other
    // reason is not quietly accepted as this one.
    expect(gap).toBeGreaterThan(fontPx);
    expect(gap).toBe(fontPx + OFFICE_LABEL_HALO_PX * 2);
    expect(officeLabelBoxesOverlap(first, second)).toBe(false);
  });

  it("round-trips a baseline through the box it reserves", () => {
    // The two halves of the conversion, against each other: a caller offers a
    // baseline and draws at whatever comes back, so a box builder and a
    // baseline reader that disagreed by the halo would move every label on the
    // floor a pixel and nothing here would notice.
    const space = createLabelSpace();
    const placed = placeOfficeLabel(
      space,
      officeScreenLabelBox({
        centerX: 100,
        baselineY: 50,
        width: 40,
        fontPx: 10,
      }),
      OFFICE_LABEL_FIXED,
    ) as OfficeLabelBox;

    expect(officeScreenLabelBaseline(placed)).toBe(50);
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
