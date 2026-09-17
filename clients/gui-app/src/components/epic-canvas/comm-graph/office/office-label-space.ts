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
