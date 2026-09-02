/**
 * Everything on the floor that is not a character: furniture, fixtures, tiles
 * and the two travelling sprites (envelope, sparkle).
 *
 * Fixed color keys only - these maps never see an `OfficeAppearance`. `Z` is
 * the per-draw tint, so one envelope map serves every accent color.
 */
import type { SpriteMap } from "@/lib/comm-graph/office/office-sprite-maps";

// ---- Desk and screen ------------------------------------------------- //
//
// Two tiles wide, with the keyboard over the LEFT tile because the chair sits
// below that tile. The mug beside the keyboard is what keeps a bare desk from
// reading as an unoccupied slab; it stays on the LEFT half because the right
// half carries the nameplate and the harness logo drawn over it.

export const DESK_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
  "OwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwwwOOOwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwwwObOwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwwwOOOwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwwOOOOOOOOOOOOOOOOwwwwwwwwwwwwO",
  "OwwOmmmmmmmmmmmmmmOwwwwwwwwwwwwO",
  "OwwOmMmMmMmMmMmMmMOwwwwwwwwwwwwO",
  "OwwOmmmmmmmmmmmmmmOwwwwwwwwwwwwO",
  "OwwOOOOOOOOOOOOOOOOwwwwwwwwwwwwO",
  "OWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWO",
  "OWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWO",
  "OWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWO",
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
];

/** Three ragged "code" lines - enough to read as work at 1x, at no cost. */
export const MONITOR_ON_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMMMMMO",
  "OMccccccccccccMO",
  "OMbbbbbbbbccccMO",
  "OMccccccccccccMO",
  "OMbbbbbbccccccMO",
  "OMccccccccccccMO",
  "OMbbbbbbbbbbccMO",
  "OMccccccccccccMO",
  "OMMMMMMMMMMMMMMO",
  ".....OMMMMO.....",
  "...OMMMMMMMMO...",
];

/**
 * The second lit frame. The code lines sit on the rows `MONITOR_ON_MAP` leaves
 * blank and carry different lengths, so alternating the two frames reads as
 * text scrolling up rather than as a screen blinking.
 */
export const MONITOR_ON_B_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMMMMMO",
  "OMbbbbbbccccccMO",
  "OMccccccccccccMO",
  "OMbbbbbbbbbbccMO",
  "OMccccccccccccMO",
  "OMbbbbbcccccccMO",
  "OMccccccccccccMO",
  "OMbbbbbbbbbcccMO",
  "OMMMMMMMMMMMMMMO",
  ".....OMMMMO.....",
  "...OMMMMMMMMO...",
];

export const MONITOR_OFF_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMMMMMO",
  "OMddddddddddddMO",
  "OMddddddddddddMO",
  "OMddddddddddddMO",
  "OMddddddddddddMO",
  "OMddddddddddddMO",
  "OMddddddddddddMO",
  "OMddddddddddddMO",
  "OMMMMMMMMMMMMMMO",
  ".....OMMMMO.....",
  "...OMMMMMMMMO...",
];

/**
 * The seat only. A back-rest is deliberately absent: the scene draws the chair
 * and then the seated character on top of it, so a rest would be hidden behind
 * the shoulders anyway and only cost silhouette clarity.
 */
export const CHAIR_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OOOOOOOOOOOO..",
  "......OmmO......",
  "......OmmO......",
  "....OOOmmOOO....",
  "...OmmmmmmmmO...",
  "...OOOOOOOOOO...",
  "..OO..OOOO..OO..",
  "..OO..OOOO..OO..",
  "................",
];

// ---- Desk plate, divider and wall sign -------------------------------- //

/**
 * The plate that stands on the desk's right half. Deliberately featureless: the
 * renderer draws a 12x12 harness logo over its top edge, so anything engraved
 * on the face would read as noise behind the logo. What survives the overlay is
 * the BASE - the dark bevel and the wood shadow on the last two rows - which is
 * all the plate has to contribute for the logo to look like it is standing on
 * something.
 */
export const NAMEPLATE_MAP: SpriteMap = [
  ".OOOOOOOOOO.",
  "OmmmmmmmmmmO",
  "OmmmmmmmmmmO",
  "OMMMMMMMMMMO",
  ".OWWWWWWWWO.",
  "..OOOOOOOO..",
];

/**
 * A frosted divider between two desk clusters in one cabin, seen top-down: a
 * 4px glass band with a metal foot. The glass is two tones split down the
 * middle rather than one flat fill, which is what makes a 4px band read as a
 * pane catching light instead of as a painted stripe.
 */
export const PARTITION_MAP: SpriteMap = [
  ".....OOOOOO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  ".....OvvVVO.....",
  "....OMmmmmMO....",
  "...OMmmmmmmMO...",
  "...OMMMMMMMMO...",
  "...OOOOOOOOOO...",
];

/**
 * The cabin's wall sign, two tiles wide. The field is one flat ink slab with a
 * metal frame, because the renderer draws the cabin's name across it as a
 * label: any pattern inside the frame would fight the text at this size.
 *
 * The field is DARK in both themes, so a label drawn on it takes a light color
 * of its own rather than the palette's theme-following `text`.
 */
export const SIGN_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
  "OmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmO",
  "OmOOOOOOOOOOOOOOOOOOOOOOOOOOOOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOBBBBBBBBBBBBBBBBBBBBBBBBBBOmO",
  "OmOOOOOOOOOOOOOOOOOOOOOOOOOOOOmO",
  "OmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmO",
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
];

// ---- Fixtures -------------------------------------------------------- //

export const PLANT_MAP: SpriteMap = [
  ".......OO.......",
  "......OGGO......",
  "..OO..OGGO..OO..",
  ".OGGO.OGGO.OGGO.",
  ".OGgO.OGgO.OgGO.",
  ".OggOOOggOOOggO.",
  "..OggggggggggO..",
  "..OGggggggggGO..",
  "...OGgggggggO...",
  "....OGggggGO....",
  ".....OGggGO.....",
  "......OGGO......",
  "......OGGO......",
  "......OGGO......",
  "......OGGO......",
  "......OGGO......",
  "..OOOOOOOOOOOO..",
  "..OwwwwwwwwwwO..",
  "..OwwwwwwwwwwO..",
  "..OWwwwwwwwwWO..",
  "...OWwwwwwwWO...",
  "...OWWwwwwWWO...",
  "....OWWWWWWO....",
  "....OOOOOOOO....",
];

export const COFFEE_MACHINE_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OMMMMMMMMMMO..",
  "..OMddddddddMO..",
  "..OMdccccccdMO..",
  "..OMddddddddMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMOOOOMMMO..",
  "..OMMMMOOMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMOOOOOOOOMO..",
  "..OMObbbbbbOMO..",
  "..OMObWWWWbOMO..",
  "..OMObWWWWbOMO..",
  "..OMObWWWWbOMO..",
  "..OMOObbbbOOMO..",
  "..OMOOOOOOOOMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OOOOOOOOOOOO..",
  "..OWWWWWWWWWWO..",
  "..OOOOOOOOOOOO..",
];

export const WHITEBOARD_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "ObbBBBBBBBBBBBBbbbbbbbbbbbbbbbbO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "ObbBBBBBBBBBBBBBBBBBBbbbbbbbbbbO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "ObbBBBBBBBBBBbbbbbbbbbbbbbbbbbbO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "ObbccccccccccccccccbbbbbbbbbbbbO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "ObbBBBBBBBBBBBBBBbbbbbbbbbbbbbbO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO",
  "OMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMO",
  "OMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMO",
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
];

export const WINDOW_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OWWWWWWWWWWWWWWO",
  "OWqqqqqqWqqqqqWO",
  "OWqqbbqqWqqqqqWO",
  "OWqbbbqqWqqbbqWO",
  "OWqqbbqqWqqqqqWO",
  "OWqqqqqqWqqqqqWO",
  "OWWWWWWWWWWWWWWO",
  "OWqqqqqqWqqqqqWO",
  "OWqqqqqqWqqqqqWO",
  "OWqqbbqqWqqqqqWO",
  "OWqqqqqqWqqqqqWO",
  "OWqqqqqqWqqqqqWO",
  "OWWWWWWWWWWWWWWO",
  "OWWWWWWWWWWWWWWO",
  "OOOOOOOOOOOOOOOO",
];

export const DOOR_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OWWWWWWWWWWWWWWO",
  "OWwwwwwOOwwwwwWO",
  "OWwwwwwOOwwwwwWO",
  "OWwOOwwOOwwOOwWO",
  "OWwOwwwOOwwwOwWO",
  "OWwOOwwOOwwOOwWO",
  "OWwwwwwOOwwwwwWO",
  "OWwwwmwOOwmwwwWO",
  "OWwwwwwOOwwwwwWO",
  "OWwOOwwOOwwOOwWO",
  "OWwOwwwOOwwwOwWO",
  "OWwOOwwOOwwOOwWO",
  "OWwwwwwOOwwwwwWO",
  "OWWWWWWWWWWWWWWO",
  "OOOOOOOOOOOOOOOO",
];

// ---- Tiles ----------------------------------------------------------- //
//
// No `O` here. An outlined floor tile draws a grid over the whole room and the
// office stops reading as a room. The two variants are an inversion of the same
// two tones, which is subtle enough to tint a checker without striping.

export const FLOOR_A_MAP: SpriteMap = [
  "FFFFFFFFFFFFFFFF",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
];

export const FLOOR_B_MAP: SpriteMap = [
  "ffffffffffffffff",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
  "fFFFFFFFFFFFFFFF",
];

/** Brick face: mortar rows at the two seams, staggered vertical joints. */
export const WALL_MAP: SpriteMap = [
  "LLLLLLLLLLLLLLLL",
  "llllllllLlllllll",
  "llllllllLlllllll",
  "llllllllLlllllll",
  "llllllllLlllllll",
  "llllllllLlllllll",
  "llllllllLlllllll",
  "llllllllLlllllll",
  "LLLLLLLLLLLLLLLL",
  "Llllllllllllllll",
  "Llllllllllllllll",
  "Llllllllllllllll",
  "Llllllllllllllll",
  "Llllllllllllllll",
  "Llllllllllllllll",
  "Llllllllllllllll",
];

/** The ledge that caps a wall run; its dark band is the wall's own shadow. */
export const WALL_TOP_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "llllllllllllllll",
  "LLLLLLLLLLLLLLLL",
  "LLLLLLLLLLLLLLLL",
  "LLLLLLLLLLLLLLLL",
  "OOOOOOOOOOOOOOOO",
];

const RUG_EDGE = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const RUG_BAND = "XXxxxxxxxxxxxxxxxxxxxxxxxxxxxxXX";
const RUG_RING = "XXxxXXXXXXXXXXXXXXXXXXXXXXXXxxXX";
const RUG_FIELD = "XXxxXxxxxxxxxxxxxxxxxxxxxxxXxxXX";

export const RUG_MAP: SpriteMap = [
  RUG_EDGE,
  RUG_EDGE,
  RUG_BAND,
  RUG_BAND,
  RUG_RING,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_FIELD,
  RUG_RING,
  RUG_BAND,
  RUG_BAND,
  RUG_EDGE,
  RUG_EDGE,
];

// ---- Travelling sprites ---------------------------------------------- //

/** Flap creases meet at the centre so direction of travel stays unambiguous. */
export const ENVELOPE_MAP: SpriteMap = [
  "OOOOOOOOOO",
  "OZbbbbbbZO",
  "ObZbbbbZbO",
  "ObbZbbZbbO",
  "ObbbZZbbbO",
  "ObbbbbbbbO",
  "ObbbbbbbbO",
  "OOOOOOOOOO",
];

export const SPARKLE_MAP: SpriteMap = [
  "...ZZ...",
  "...ZZ...",
  "..ZZZZ..",
  "ZZZZZZZZ",
  "ZZZZZZZZ",
  "..ZZZZ..",
  "...ZZ...",
  "...ZZ...",
];

// ---- Bubbles --------------------------------------------------------- //
//
// 14x12, with a 2px tail at the bottom centre (columns 6-7, rows 10-11). The
// scene anchors a bubble by that tail, so every bubble shares one offset.

export const BUBBLE_AWAITING_MAP: SpriteMap = [
  "..OOOOOOOOOO..",
  ".ObbbbbbbbbbO.",
  "ObbbbbbbbbbbbO",
  "ObbbbbbbbbbbbO",
  "ObbBBbBBbBBbbO",
  "ObbBBbBBbBBbbO",
  "ObbbbbbbbbbbbO",
  "ObbbbbbbbbbbbO",
  ".ObbbbbbbbbbO.",
  "..OOOObbOOOO..",
  ".....ObbO.....",
  "......OO......",
];

export const BUBBLE_ATTENTION_MAP: SpriteMap = [
  "..OOOOOOOOOO..",
  ".OyyyyyyyyyyO.",
  "OyyyyyyyyyyyyO",
  "OyyyyyBByyyyyO",
  "OyyyyyBByyyyyO",
  "OyyyyyBByyyyyO",
  "OyyyyyyyyyyyyO",
  "OyyyyyBByyyyyO",
  ".OyyyyyyyyyyO.",
  "..OOOOyyOOOO..",
  ".....OyyO.....",
  "......OO......",
];

export const BUBBLE_NOTICE_MAP: SpriteMap = [
  "..OOOOOOOOOO..",
  ".OnnnnnnnnnnO.",
  "OnnnnBBBnnnnnO",
  "OnnnnnnBnnnnnO",
  "OnnnnnBBnnnnnO",
  "OnnnnnBnnnnnnO",
  "OnnnnnnnnnnnnO",
  "OnnnnnBnnnnnnO",
  ".OnnnnnnnnnnO.",
  "..OOOOnnOOOO..",
  ".....OnnO.....",
  "......OO......",
];

/** A raised hand, not lettering - two glyphs are unreadable at this size. */
export const BUBBLE_HELLO_MAP: SpriteMap = [
  "..OOOOOOOOOO..",
  ".ObbbbbbbbbbO.",
  "ObbbBbBbBbbbbO",
  "ObbbBbBbBbbbbO",
  "ObbbBBBBBbbbbO",
  "ObbBBBBBBBbbbO",
  "ObbbBBBBBbbbbO",
  "ObbbbBBBbbbbbO",
  ".ObbbbbbbbbbO.",
  "..OOOObbOOOO..",
  ".....ObbO.....",
  "......OO......",
];

export const BUBBLE_SLEEP_MAP: SpriteMap = [
  "..OOOOOOOOOO..",
  ".ObbbbbbbbbbO.",
  "ObbbbbbbbbbbbO",
  "ObbbBBBBBbbbbO",
  "ObbbbbbBbbbbbO",
  "ObbbbbBbbbbbbO",
  "ObbbbBbbbbbbbO",
  "ObbbBBBBBbbbbO",
  ".ObbbbbbbbbbO.",
  "..OOOObbOOOO..",
  ".....ObbO.....",
  "......OO......",
];
