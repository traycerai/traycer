/**
 * EVERY PIECE OF TEXT THE OFFICE PUTS ON SCREEN, IN ONE OCCUPANCY SET.
 *
 * The floor letters itself through five independent channels - room and board
 * plates, the claim line under a plate, a storey's own name, an agent's name
 * tag, and the name Find puts on a match the tag path missed - and until this
 * module existed exactly one of them resolved collisions, against exactly
 * itself. Name tags have never overlapped name tags. Everything else was drawn
 * where its own arithmetic put it and painted over whatever was already there:
 * a census over every view, four epic shapes, four populations, two seeds and
 * four zooms found overlapping text in 129 of 768 cases, in seven distinct
 * pairs - `HOSPITAL` on `BUS STOP`, `LOUNGE` on `FRONT DESK`, a civic plate on
 * a host's floor sign, two pod plates, two host signs.
 *
 * So the rule is not per channel any more. A frame opens one space, every
 * channel places into it in priority order, and a label that cannot find room
 * is DROPPED rather than drawn on top of one that already has some. That is
 * the bargain `layoutNameTags` has always made and the reason it reads as the
 * only channel that behaved: a dropped label costs one reading, a drawn one
 * costs two.
 *
 * WHY NOT FIX THE PLAN INSTEAD. Because the collision is not in the plan. A
 * plate's backing is a fixed fourteen screen pixels at every zoom while the
 * gap between the two rooms it separates is world art that shrinks with the
 * camera, so any two signs close enough in world space collide at SOME zoom
 * and not at others - `LOUNGE` and `FRONT DESK` overlap at 1x in mission
 * control and clear each other at 0.7x and 1.6x, in every shape and at every
 * population. There is no arrangement of rooms that is collision-free at all
 * zooms, which makes this the renderer's problem by construction.
 */

/** A label's footprint in SCREEN pixels - the same space the plates paint in. */
export interface OfficeLabelBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * How far a label may move off its anchor before it is given up on.
 *
 * `dy` is signed: a name tag drops DOWN the screen away from the head it names,
 * and a floating sign lifts UP away from the room it hangs over. `max` is how
 * many attempts it gets after the anchor itself, so `{ dy: 0, max: 0 }` is a
 * label that takes its anchor or nothing.
 */
export interface OfficeLabelShift {
  readonly dy: number;
  readonly max: number;
}

/**
 * A label pinned to its anchor: it is drawn there or not at all.
 *
 * What makes a label fixed is having art UNDER it. A wall sign's plate sits on
 * a board sprite that was painted in the world pass, before the transform was
 * dropped and before any of this ran, so lifting the lettering a line would
 * leave the board behind and read as two objects. A floating sign has no board
 * - that is what `OfficeSignMount` says - and a floor sign is lettering on
 * bare floor, so both of those can move.
 */
export const OFFICE_LABEL_FIXED: OfficeLabelShift = { dy: 0, max: 0 };

/**
 * The boxes already taken this frame.
 *
 * A mutable array behind an interface rather than a class, so the canvas can
 * hold ONE at module scope and reset it per frame the way it resets its other
 * scratch: a fresh space thirty times a second is garbage the collector has to
 * walk for as long as an office is open.
 */
export interface OfficeLabelSpace {
  readonly boxes: OfficeLabelBox[];
}

export function createLabelSpace(): OfficeLabelSpace {
  return { boxes: [] };
}

export function resetLabelSpace(space: OfficeLabelSpace): OfficeLabelSpace {
  space.boxes.length = 0;
  return space;
}

export function officeLabelBoxesOverlap(
  a: OfficeLabelBox,
  b: OfficeLabelBox,
): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/**
 * How far a screen label's backing bleeds past its glyphs, in screen pixels.
 *
 * The floor's colours are arbitrary - a character's shirt may land on the
 * foreground colour - so a name is OUTLINED rather than trusted to contrast
 * with whatever it sits on, by painting the same text once at each of the four
 * neighbouring pixels and then again on top. That outline is ink like any
 * other: two labels whose glyph runs merely touch still paint into each
 * other's halo, and since {@link placeOfficeLabel} treats edge-touching boxes
 * as clear - and a lift lands a box EXACTLY flush with the one it moved away
 * from, by construction - flush is the common case rather than the rare one.
 *
 * So the box a label reserves is the box it PAINTS, halo included.
 */
export const OFFICE_LABEL_HALO_PX = 1;

/** The face the office's non-plate lettering is set in - tags and floor signs. */
export const OFFICE_LABEL_FONT_PX = 10;

/**
 * THE BOX A SCREEN LABEL ACTUALLY PAINTS, from where it would be drawn.
 *
 * ONE EM ABOVE THE BASELINE, plus the halo on all four sides. That is a LINE
 * BOX rather than a bounding box: real glyphs sit at `[baseline - ascent,
 * baseline + descent]`, which is the same em displaced DOWN by the descent,
 * since a face's ascent and descent are what divide its em between them. So
 * the box is the ink translated by a constant, every screen label on this
 * canvas is translated by the same constant, and two disjoint boxes are two
 * disjoint runs of ink - which is the property the whole pass rests on.
 *
 * Measuring the real ascent instead would buy nothing and cost the width
 * cache: `measureText`'s bounding-box metrics are per STRING, so they cannot
 * be keyed on a face the way {@link OFFICE_LABEL_FONT_PX} is, and jsdom does
 * not report them at all.
 */
export function officeScreenLabelBox(label: {
  /** Horizontal centre, in screen pixels - the text is drawn centre-aligned. */
  readonly centerX: number;
  /** Where the alphabetic baseline would sit, in screen pixels. */
  readonly baselineY: number;
  /** Measured glyph width, WITHOUT the halo. */
  readonly width: number;
  readonly fontPx: number;
}): OfficeLabelBox {
  const half = label.width / 2 + OFFICE_LABEL_HALO_PX;
  return {
    left: label.centerX - half,
    right: label.centerX + half,
    top: label.baselineY - label.fontPx - OFFICE_LABEL_HALO_PX,
    bottom: label.baselineY + OFFICE_LABEL_HALO_PX,
  };
}

/**
 * The baseline to draw at, given the box the space handed back.
 *
 * The inverse of {@link officeScreenLabelBox}, and it lives beside it so the
 * two cannot drift: a placed box may have been lifted off the one that was
 * offered, and its bottom edge is a halo BELOW the baseline rather than on it.
 * Drawing at `box.bottom` would put every label one pixel low.
 */
export function officeScreenLabelBaseline(box: OfficeLabelBox): number {
  return box.bottom - OFFICE_LABEL_HALO_PX;
}

/**
 * One line of this face - what a label moves by when it gives way.
 *
 * It is the box's own HEIGHT, which is what makes one attempt enough: a step
 * shorter than the box would land a label still touching the neighbour it was
 * lifting away from, and every extra attempt is another chance to be dropped.
 */
export function officeScreenLabelLineHeight(fontPx: number): number {
  return fontPx + OFFICE_LABEL_HALO_PX * 2;
}

function shifted(box: OfficeLabelBox, dy: number): OfficeLabelBox {
  if (dy === 0) return box;
  return {
    left: box.left,
    right: box.right,
    top: box.top + dy,
    bottom: box.bottom + dy,
  };
}

/**
 * Takes the first free slot at or beyond `box`, and records it.
 *
 * `null` means every attempt was occupied and the caller must not draw. The
 * box that comes back is the one to draw AT - callers measure everything they
 * hang off a label (a subtitle line, a ward's beacon) from the returned box
 * rather than from the one they offered, because those two differ by exactly
 * the displacement this applied.
 */
export function placeOfficeLabel(
  space: OfficeLabelSpace,
  box: OfficeLabelBox,
  shift: OfficeLabelShift,
): OfficeLabelBox | null {
  for (let attempt = 0; attempt <= shift.max; attempt += 1) {
    const candidate = shifted(box, shift.dy * attempt);
    if (
      space.boxes.some((other) => officeLabelBoxesOverlap(candidate, other))
    ) {
      continue;
    }
    space.boxes.push(candidate);
    return candidate;
  }
  return null;
}
