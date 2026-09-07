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

// ---- Screens for the other model tiers -------------------------------- //
//
// Three chassis, one per tier, all standing on the SAME desk row: their maps
// differ in height, so the scene lifts each by its own offset rather than
// sharing one. Every lit map spends its bright pixels on ragged `b` code lines
// over a `c` field, which is the one thing that reads as work at 1x.

/** A laptop: a hinged lid over a keyboard deck, sized for the small tier. */
export const MONITOR_SMALL_ON_MAP: SpriteMap = [
  ".OOOOOOOOOO.",
  ".OMccccccMO.",
  ".OMbbbbccMO.",
  ".OMccccccMO.",
  ".OMbbbbbcMO.",
  ".OMMMMMMMMO.",
  "OOOOOOOOOOOO",
  "OmMmMmMmMmMO",
  "OOOOOOOOOOOO",
];

export const MONITOR_SMALL_OFF_MAP: SpriteMap = [
  ".OOOOOOOOOO.",
  ".OMddddddMO.",
  ".OMddddddMO.",
  ".OMddddddMO.",
  ".OMddddddMO.",
  ".OMMMMMMMMO.",
  "OOOOOOOOOOOO",
  "OmMmMmMmMmMO",
  "OOOOOOOOOOOO",
];

/**
 * Two screens on one stand, for the large tier. The panes are separate boxes
 * meeting at a doubled bezel down the middle: a single wide pane would read as
 * one enormous television rather than as a two-monitor rig.
 */
export const MONITOR_WIDE_ON_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMOOMMMMMMMMMMO",
  "OMccccccccMOOMccccccccMO",
  "OMbbbbbcccMOOMbbbcccccMO",
  "OMccccccccMOOMccccccccMO",
  "OMbbbbccccMOOMbbbbbbccMO",
  "OMccccccccMOOMccccccccMO",
  "OMbbbbbbbcMOOMbbbbccccMO",
  "OMccccccccMOOMccccccccMO",
  "OMMMMMMMMMMOOMMMMMMMMMMO",
  "........OMMMMMMO........",
  ".....OMMMMMMMMMMMMO.....",
];

/**
 * The second lit frame, on the same terms as `MONITOR_ON_B_MAP`: the code lines
 * move to the rows the first frame leaves blank and change length, so the pair
 * reads as text scrolling rather than as the rig blinking. The chassis rows are
 * pinned to the first frame's - a moving bezel would read as a twitch.
 */
export const MONITOR_WIDE_ON_B_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMOOMMMMMMMMMMO",
  "OMbbbcccccMOOMbbbbbbccMO",
  "OMccccccccMOOMccccccccMO",
  "OMbbbbbbccMOOMbbccccccMO",
  "OMccccccccMOOMccccccccMO",
  "OMbbbbccccMOOMbbbbbbbcMO",
  "OMccccccccMOOMccccccccMO",
  "OMbbbbbcccMOOMbbbcccccMO",
  "OMMMMMMMMMMOOMMMMMMMMMMO",
  "........OMMMMMMO........",
  ".....OMMMMMMMMMMMMO.....",
];

export const MONITOR_WIDE_OFF_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMOOMMMMMMMMMMO",
  "OMddddddddMOOMddddddddMO",
  "OMddddddddMOOMddddddddMO",
  "OMddddddddMOOMddddddddMO",
  "OMddddddddMOOMddddddddMO",
  "OMddddddddMOOMddddddddMO",
  "OMddddddddMOOMddddddddMO",
  "OMddddddddMOOMddddddddMO",
  "OMMMMMMMMMMOOMMMMMMMMMMO",
  "........OMMMMMMO........",
  ".....OMMMMMMMMMMMMO.....",
];

/**
 * A crashed screen: the medium chassis, its field flooded `notice` red with a
 * sad face in the palette's brightest color. One map serves every tier - a
 * crash is a state, not a hardware size, and three red screens would be three
 * chances for them to drift apart.
 *
 * The face carries NO `screenLit` pixel: "the screen is on and something is
 * wrong" has to be legible as one glance at the color, before any glyph is
 * read.
 */
export const MONITOR_CRASH_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMMMMMO",
  "OMnnnnnnnnnnnnMO",
  "OMnnnnbnnbnnnnMO",
  "OMnnnnnnnnnnnnMO",
  "OMnnnnnnnnnnnnMO",
  "OMnnnnnbbnnnnnMO",
  "OMnnnnbnnbnnnnMO",
  "OMnnnnnnnnnnnnMO",
  "OMMMMMMMMMMMMMMO",
  ".....OMMMMO.....",
  "...OMMMMMMMMO...",
];

// ---- Desk clutter ----------------------------------------------------- //
//
// Unanswered requests, as a pile that grows. The three maps share ONE face and
// differ only by how many 2px front edges are stacked below it, so the scene
// can swap between them bottom-anchored and the face rises a fixed step each
// time instead of the whole pile redrawing itself.

const ENVELOPE_STACK_FACE: SpriteMap = [
  "OOOOOOOOOO",
  "ObbbbbbbbO",
  "ObMbbbbMbO",
  "ObbMbbMbbO",
  "ObbbMMbbbO",
  "OOOOOOOOOO",
];

/** The front edge of one more envelope under the pile. */
const ENVELOPE_STACK_EDGE: SpriteMap = ["ObbbbbbbbO", "OOOOOOOOOO"];

export const ENVELOPE_STACK_1_MAP: SpriteMap = [...ENVELOPE_STACK_FACE];

export const ENVELOPE_STACK_2_MAP: SpriteMap = [
  ...ENVELOPE_STACK_FACE,
  ...ENVELOPE_STACK_EDGE,
];

export const ENVELOPE_STACK_3_MAP: SpriteMap = [
  ...ENVELOPE_STACK_FACE,
  ...ENVELOPE_STACK_EDGE,
  ...ENVELOPE_STACK_EDGE,
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

/**
 * The cafeteria's coffee machine.
 *
 * Legible at 16px is the whole requirement, and a plain metal box is not: the
 * cup under the nozzle is what says "coffee" rather than "vending machine" or
 * "server rack". So the alcove is dark to set the cup off, the cup is bright
 * with a `woodDark` fill for what is in it, two pixels of steam rise between
 * the nozzle and the rim, and a `metalLight` drip tray closes the recess.
 */
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
  "..OMMMMbbMMMMO..",
  "..OMMMbMMbMMMO..",
  "..OMOOOOOOOOMO..",
  "..OMOBBBBBBOMO..",
  "..OMOBbbbbBOMO..",
  "..OMOBbWWbBOMO..",
  "..OMOBbWWbBOMO..",
  "..OMOBbbbbBOMO..",
  "..OMOOOOOOOOMO..",
  "..OMmmmmmmmmMO..",
  "..OMMMMMMMMMMO..",
  "..OMMMMMMMMMMO..",
  "..OOOOOOOOOOOO..",
  "..OWWWWWWWWWWO..",
  "..OOOOOOOOOOOO..",
];

/**
 * The cafeteria's water cooler: a `sky` bottle over a metal column, the tap
 * recessed into the column's face, and one cup standing beside it on the floor.
 *
 * The cup is what makes the fixture read as a cooler rather than as a tall blue
 * cabinet at 1x, so it is part of the art rather than a second prop the layout
 * would have to find a tile for.
 */
export const WATER_COOLER_MAP: SpriteMap = [
  "...OOOOOOOO.....",
  "...OqqqqqqO.....",
  "...OqqqqqqO.....",
  "...OqbqqqqO.....",
  "...OqbqqqqO.....",
  "...OqqqqqqO.....",
  "...OqqqqqqO.....",
  "....OqqqqO......",
  ".....OqqO.......",
  "..OOOOOOOOOO....",
  "..ObbbbbbbbO....",
  "..OmmmmmmmmO....",
  "..OmmmmmmmmO....",
  "..OmMMMMMMmO....",
  "..OmMOOOOMmO....",
  "..OmMObbOMmO....",
  "..OmMObbOMmO....",
  "..OmMOOOOMmO....",
  "..OmMMMMMMmO....",
  "..OmmmmmmmmO....",
  "..OmmmmmmmmO.OOO",
  "..OMMMMMMMMO.ObO",
  "..OMMMMMMMMO.ObO",
  "..OOOOOOOOOO.OOO",
];

/**
 * A round cafeteria table seen from above, two tiles wide, with a cup set at
 * each of the two seats. The pedestal is drawn under the top rather than legs at
 * the corners: a round table's legs would read as noise at this size, and the
 * seats are floor tiles beside it rather than furniture of their own.
 */
export const CAFE_TABLE_MAP: SpriteMap = [
  "................................",
  "........OOOOOOOOOOOOOOOO........",
  ".....OOOwwwwwwwwwwwwwwwwOOO.....",
  "...OOwwwwwwwwwwwwwwwwwwwwwwOO...",
  "..OwwwwwwwwwwwwwwwwwwwwwwwwwwO..",
  ".OwwwwwObbOwwwwwwwwwwObbOwwwwwO.",
  ".OwwwwwObbOwwwwwwwwwwObbOwwwwwO.",
  ".OwwwwwOOOOwwwwwwwwwwOOOOwwwwwO.",
  ".OwwwwwwwwwwwwwwwwwwwwwwwwwwwwO.",
  "..OWWWWWWWWWWWWWWWWWWWWWWWWWWO..",
  "...OOWWWWWWWWWWWWWWWWWWWWWWOO...",
  ".....OOOWWWWWWWWWWWWWWWWOOO.....",
  "........OOOOOOOOOOOOOOOO........",
  "..............OWWO..............",
  "..............OWWO..............",
  "............OOOOOOOO............",
];

/**
 * The vending machine: a lit glass front over four shelves of stock, with the
 * delivery slot dark at the bottom. The stock rows take four different palette
 * colors because a single-colored grid reads as a bookshelf.
 */
export const VENDING_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OMMMMMMMMMMMMMMO",
  "OMOOOOOOOOOOOOMO",
  "OMOvccccccccvOMO",
  "OMOvyyyyyyyyvOMO",
  "OMOvOOOOOOOOvOMO",
  "OMOvccccccccvOMO",
  "OMOvnnnnnnnnvOMO",
  "OMOvOOOOOOOOvOMO",
  "OMOvccccccccvOMO",
  "OMOvggggggggvOMO",
  "OMOvOOOOOOOOvOMO",
  "OMOvccccccccvOMO",
  "OMOvqqqqqqqqvOMO",
  "OMOvOOOOOOOOvOMO",
  "OMOvccccccccvOMO",
  "OMOOOOOOOOOOOOMO",
  "OMMMMMMMMMMMMMMO",
  "OMOOOOOOOOOOOOMO",
  "OMOddddddddddOMO",
  "OMOddddddddddOMO",
  "OMOOOOOOOOOOOOMO",
  "OMMMMMMMMMMMMMMO",
  "OOOOOOOOOOOOOOOO",
];

/**
 * The cafeteria's menu board, two tiles wide, mounted on the break room's wall
 * face the way a cabin's sign is. Unlike the sign it carries its OWN content -
 * three chalk lines and a cup glyph - because nothing is ever drawn over it: the
 * renderer has no cafeteria name to write.
 */
export const MENU_BOARD_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
  "OwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OwOOOOOOOOOOOOOOOOOOOOOOOOOOOOwO",
  "OwOBBBBBBBBBBBBBBBBBBBBBBBBBBOwO",
  "OwOBbbbbbbbbBBBBBBBBBBBBBBBBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBBBBBBBBBOwO",
  "OwOBbbbbbbbbbbbBBBBBBBBBBBBBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBBBBBBBBBOwO",
  "OwOBbbbbbbBBBBBBBBBBBBBBBBBBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBBBBBBBBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBOOOOOBBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBObbbOOBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBObbbOOBBOwO",
  "OwOBBBBBBBBBBBBBBBBBBOOOOOBBBOwO",
  "OwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwO",
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
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

/**
 * The wall clock's FACE only. The renderer draws the hands over it from a
 * `clock` drawable, so the centre four-by-four is left transparent: hands are
 * the one part of a clock that has to be redrawn every minute, and baking a hub
 * into the art would mean the art and the hands could disagree about where the
 * pivot is.
 *
 * Only the quarter ticks are marked. Twelve ticks on a 12px dial is a ring of
 * noise; four is enough to tell which way is up, which is all a wall clock in
 * the background has to say.
 */
export const CLOCK_MAP: SpriteMap = [
  "...OOOOOO...",
  "..OMMMMMMO..",
  ".OMMbbbbMMO.",
  "OMMbbBBbbMMO",
  "OMbb....bbMO",
  "OMBb....bBMO",
  "OMBb....bBMO",
  "OMbb....bbMO",
  "OMMbbBBbbMMO",
  ".OMMbbbbMMO.",
  "..OMMMMMMO..",
  "...OOOOOO...",
];

/**
 * A cloth thrown over an archived agent's desk. Exactly the desk's own footprint
 * so the scene can draw it at the desk's top-left and cover it whole - a sheet
 * that had to be positioned would be a second offset to keep in sync with the
 * desk's.
 *
 * Opaque edge to edge for the same reason: the point is that the desk beneath
 * has STOPPED being readable, so anything showing through would undo it.
 */
const SHEET_EDGE = "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO";
const SHEET_FLAT = "ObbbbbbbbbbbbbbbbbbbbbbbbbbbbbbO";
const SHEET_FOLD_A = "ObbbbmbbbbbbbbbbbbbbbbbmbbbbbbbO";
const SHEET_FOLD_B = "ObbbbbbbbbbmbbbbbbbbmbbbbbbbbbbO";
/** The cloth sagging where the desk's edge stops holding it up. */
const SHEET_DROOP = "OmmbbbbbbbbbbbbbbbbbbbbbbbbbbmmO";
const SHEET_HEM = "OmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmO";
const SHEET_SHADOW = "OMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMO";

export const DUST_SHEET_MAP: SpriteMap = [
  SHEET_EDGE,
  SHEET_FLAT,
  SHEET_FOLD_A,
  SHEET_FOLD_A,
  SHEET_FLAT,
  SHEET_FOLD_B,
  SHEET_FOLD_B,
  SHEET_FLAT,
  SHEET_DROOP,
  SHEET_FLAT,
  SHEET_FOLD_A,
  SHEET_FOLD_A,
  SHEET_FLAT,
  SHEET_HEM,
  SHEET_SHADOW,
  SHEET_EDGE,
];

/** A packed carton beside an archived desk; the tape runs over the lid seam. */
export const BOX_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OOOOOOOmmOOOOOOO",
  "OWWWWWWmmWWWWWWO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OwwwwwwmmwwwwwwO",
  "OWwwwwwmmwwwwwWO",
  "OWWWWWWmmWWWWWWO",
  "OOOOOOOOOOOOOOOO",
];

/**
 * The lobby counter, two tiles wide: a light top over a panelled wood front,
 * with a call bell standing on the right of the top. The bell is three pixels
 * and is the whole reason the counter reads as reception rather than as a
 * second desk seen from the front.
 */
const RECEPTION_FRONT = "OwwwwwwwWwwwwwwwWwwwwwwwWwwwwwwO";
const RECEPTION_BAND = "OWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWO";

export const RECEPTION_MAP: SpriteMap = [
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
  "OllllllllllllllllllllllllOlllllO",
  "OlllllllllllllllllllllllyyyllllO",
  "OlllllllllllllllllllllllOyOllllO",
  "OMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMO",
  RECEPTION_FRONT,
  RECEPTION_FRONT,
  RECEPTION_FRONT,
  RECEPTION_BAND,
  RECEPTION_FRONT,
  RECEPTION_FRONT,
  RECEPTION_FRONT,
  RECEPTION_FRONT,
  RECEPTION_BAND,
  RECEPTION_BAND,
  "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",
];

/**
 * The stairwell, seen from above like everything else on the floor: six treads
 * separated by a dark riser line, with a rail running down the right side. The
 * riser is what carries the read - a flight of flat treads with no line between
 * them is a ramp.
 */
const STAIR_TREAD = "OlllllllllllllllllllllllllOmMmOO";
const STAIR_RISER = "OLLLLLLLLLLLLLLLLLLLLLLLLLOmMmOO";
const STAIR_EDGE = "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO";

export const STAIRS_MAP: SpriteMap = [
  STAIR_EDGE,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_RISER,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_RISER,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_RISER,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_RISER,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_RISER,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_TREAD,
  STAIR_RISER,
  STAIR_EDGE,
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

/**
 * A two-tile cafeteria sofa, seen from above like every other piece of
 * furniture here: the backrest is the darker band along the TOP edge, two
 * cushions fill the seat, and the wooden legs peek out at the bottom corners.
 */
export const SOFA_MAP: SpriteMap = [
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OXXXXXXXXXXXXXXXXXXXXXXXXXXO..",
  "..OXXXXXXXXXXXXXXXXXXXXXXXXXXO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OxxxxxxxxxxOOxxxxxxxxxxxxxxO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "...OWWO................OWWO.....",
  "...OWWO................OWWO.....",
  "...OOOO................OOOO.....",
  "................................",
];

/**
 * The waste bin: a grey drum with a rim, and one sheet of paper sticking out
 * over the lip - the paper is what stops it reading as a plant pot at 16px.
 */
export const BIN_MAP: SpriteMap = [
  "................",
  "................",
  ".........bb.....",
  "........bbbb....",
  ".......bbbb.....",
  "...OOOOOOOOOO...",
  "...OmmmmmmmmO...",
  "...OMMMMMMMMO...",
  "...OMmmmmmmMO...",
  "...OMmMMMMmMO...",
  "...OMmMMMMmMO...",
  "...OMmMMMMmMO...",
  "...OMmMMMMmMO...",
  "....OMmMMmMO....",
  "....OMMMMMMO....",
  "....OOOOOOOO....",
];

/** A crumpled sheet mid-flight: white with one grey crease so it reads round. */
export const PAPER_BALL_MAP: SpriteMap = [".bb.", "bbMb", "bbbb", ".bb."];

/** The watering can an idle agent carries to a plant: green body, thin spout. */
export const WATERING_CAN_MAP: SpriteMap = [
  "...OOO..",
  "..OggO..",
  "OOgggO..",
  "OgggggO.",
  "OgggggO.",
  ".OGGGO..",
  ".OGGGO..",
  "..OOO...",
];

/**
 * The break room's ping-pong table, seen from above: a green bed with a white
 * net across the middle and a paddle resting at each end. The net is what
 * separates it from any other two-tile table at this size.
 */
export const PINGPONG_TABLE_MAP: SpriteMap = [
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "..OGggggggggggggggggggggggggGO..",
  "..OGgbbggggggggggggggggggbbgGO..",
  "..OGgbbgggggggggbgggggggggbbgO..",
  "..OGggggggggggggbggggggggggggO..",
  "..OGggggggggggggbggggggggggggO..",
  "..OGggggggggggggbggggggggggggO..",
  "..OGggggggggggggbggggggggggggO..",
  "..OGggggggggggggbggggggggggggO..",
  "..OGgbbgggggggggbgggggggggbbgO..",
  "..OGgbbggggggggggggggggggbbgGO..",
  "..OGggggggggggggggggggggggggGO..",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "....OWWO..............OWWO......",
];

/**
 * An arcade cabinet: dark shell, a lit screen carrying two colour pixels so it
 * reads as a game rather than a monitor, and a joystick panel below it.
 */
export const ARCADE_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OBBBBBBBBBBO..",
  "..OBOOOOOOOOBO..",
  "..OBOddddddOBO..",
  "..OBOdynddddOO..",
  "..OBOddddnyddO..",
  "..OBOddccddddO..",
  "..OBOddddddOBO..",
  "..OBOOOOOOOOBO..",
  "..OBBBBBBBBBBO..",
  "..OBBBBBBBBBBO..",
  "..OOOOOOOOOOOO..",
  "..OmmmmmmmmmmO..",
  "..OmmOnOmyOmmO..",
  "..OmmOOOmOOmmO..",
  "..OmmmmmmmmmmO..",
  "..OOOOOOOOOOOO..",
  "..OBBBBBBBBBBO..",
  "..OBBBBBBBBBBO..",
  "..OBBBBBBBBBBO..",
  "..OBBBBBBBBBBO..",
  "..OBBBBBBBBBBO..",
  "..OWWWWWWWWWWO..",
  "..OOOOOOOOOOOO..",
];

/**
 * The two floor tiles of a sub-team POD: the ordinary checker shifted a few
 * shades toward the glass tones, so a region of them reads as one area
 * without a border drawn round it. No outline - a pod is a tint, not a box.
 */
export const FLOOR_POD_A_MAP: SpriteMap = [
  "ffffffffvfffffff",
  "ffffffffffffffff",
  "ffffvfffffffffff",
  "ffffffffffffffff",
  "ffffffffffffvfff",
  "ffffffffffffffff",
  "ffvfffffffffffff",
  "ffffffffffffffff",
  "ffffffffffvfffff",
  "ffffffffffffffff",
  "ffffffvfffffffff",
  "ffffffffffffffff",
  "ffffffffffffffvf",
  "ffffffffffffffff",
  "fffvffffffffffff",
  "ffffffffffffffff",
];

export const FLOOR_POD_B_MAP: SpriteMap = [
  "FFFFFFFFFFFVFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFVFFFFFFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFFVFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FVFFFFFFFFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFFFFFFVFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFVFFFFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFVFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFFFFFFFVF",
  "FFFFFFFFFFFFFFFF",
];

/**
 * The horizontal partition: the same frosted band as {@link PARTITION_MAP}
 * turned across the tile, with a base line under it so it reads as standing
 * rather than lying on the floor.
 */
export const PARTITION_H_MAP: SpriteMap = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "OOOOOOOOOOOOOOOO",
  "vvvvvvvvvvvvvvvv",
  "vvvvvvvvvvvvvvvv",
  "VVVVVVVVVVVVVVVV",
  "OOOOOOOOOOOOOOOO",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

/**
 * A pod's name plate: a dark field with a light border, sized so the renderer
 * can draw the pod's name across it the way a cabin sign carries a room name.
 */
export const POD_PLATE_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..ObbbbbbbbbbO..",
  "..ObBBBBBBBBbO..",
  "..ObBBBBBBBBbO..",
  "..ObBBBBBBBBbO..",
  "..ObBBBBBBBBbO..",
  "..ObbbbbbbbbbO..",
  "..OOOOOOOOOOOO..",
];

/**
 * The WARM sibling of the pod checker: the same floor shifted a few shades
 * toward the wood tones. Two tinted pairs are what let two neighbouring pods
 * read as different areas without either gaining a border.
 */
export const FLOOR_POD_WARM_A_MAP: SpriteMap = [
  "ffffffffwfffffff",
  "ffffffffffffffff",
  "ffffwfffffffffff",
  "ffffffffffffffff",
  "ffffffffffffwfff",
  "ffffffffffffffff",
  "ffwfffffffffffff",
  "ffffffffffffffff",
  "ffffffffffwfffff",
  "ffffffffffffffff",
  "ffffffwfffffffff",
  "ffffffffffffffff",
  "ffffffffffffffwf",
  "ffffffffffffffff",
  "fffwffffffffffff",
  "ffffffffffffffff",
];

export const FLOOR_POD_WARM_B_MAP: SpriteMap = [
  "FFFFFFFFFFFWFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFWFFFFFFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFFWFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FWFFFFFFFFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFFFFFFWFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFWFFFFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFWFFFFFFF",
  "FFFFFFFFFFFFFFFF",
  "FFFFFFFFFFFFFFWF",
  "FFFFFFFFFFFFFFFF",
];

/**
 * A planter box marking a pod's edge: a wooden trough under a clipped hedge.
 * Symmetric on both axes so one sprite serves every side of an area.
 */
export const PLANTER_MAP: SpriteMap = [
  "................",
  "..OOOOOOOOOOOO..",
  "..OggGGggGGggO..",
  "..OgGGggGGggGO..",
  "..OGGggGGggGGO..",
  "..OggGGggGGggO..",
  "..OgGGggGGggGO..",
  "..OGGggGGggGGO..",
  "..OOOOOOOOOOOO..",
  "..OwwwwwwwwwwO..",
  "..OwWWwwwwWWwO..",
  "..OwwwwwwwwwwO..",
  "..OWWWWWWWWWWO..",
  "..OOOOOOOOOOOO..",
  "................",
  "................",
];

/**
 * A low bookshelf on a pod's edge, seen from above: a wooden carcass with
 * coloured spines standing in it. The vertical run.
 */
export const SHELF_MAP: SpriteMap = [
  "....OOOOOOOO....",
  "....OwwwwwwO....",
  "....OwOOOOwO....",
  "....OwOnnOwO....",
  "....OwOnnOwO....",
  "....OwOyyOwO....",
  "....OwOyyOwO....",
  "....OwOggOwO....",
  "....OwOggOwO....",
  "....OwOqqOwO....",
  "....OwOqqOwO....",
  "....OwOOOOwO....",
  "....OwwwwwwO....",
  "....OWWWWWWO....",
  "....OOOOOOOO....",
  "................",
];

/** The bookshelf turned along a horizontal edge. */
export const SHELF_H_MAP: SpriteMap = [
  "................",
  "................",
  "................",
  "................",
  "OOOOOOOOOOOOOOOO",
  "OwwwwwwwwwwwwwwO",
  "OwOOOOOOOOOOOOwO",
  "OwOnnyyggqqnnOwO",
  "OwOnnyyggqqnnOwO",
  "OwOOOOOOOOOOOOwO",
  "OwwwwwwwwwwwwwwO",
  "OWWWWWWWWWWWWWWO",
  "OOOOOOOOOOOOOOOO",
  "................",
  "................",
  "................",
];

/** A rolled sleeping bag with a pillow at its head, for the nap corner. */
export const SLEEP_BAG_MAP: SpriteMap = [
  "................",
  "................",
  "....OOOOOOOO....",
  "...ObbbbbbbbO...",
  "...ObbbbbbbbO...",
  "...OOOOOOOOOO...",
  "..OqqqqqqqqqqO..",
  "..OqVVqqqqVVqO..",
  "..OqqqqqqqqqqO..",
  "..OqVVqqqqVVqO..",
  "..OqqqqqqqqqqO..",
  "..OqVVqqqqVVqO..",
  "..OqqqqqqqqqqO..",
  "..OqVVqqqqVVqO..",
  "..OqqqqqqqqqqO..",
  "..OqVVqqqqVVqO..",
  "..OqqqqqqqqqqO..",
  "..OqVVqqqqVVqO..",
  "..OqqqqqqqqqqO..",
  "..OOOOOOOOOOOO..",
  "...OWWWWWWWWO...",
  "...OOOOOOOOOO...",
  "................",
  "................",
];

/** A soft armchair seen from above: back along the top, arms down the sides. */
export const ARMCHAIR_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OXXXXXXXXXXO..",
  "..OXXXXXXXXXXO..",
  "..OOOOOOOOOOOO..",
  "..OXXOxxxxOXXO..",
  "..OXXOxxxxOXXO..",
  "..OXXOxxxxOXXO..",
  "..OXXOxxxxOXXO..",
  "..OXXOxxxxOXXO..",
  "..OXXOxxxxOXXO..",
  "..OXXOOOOOOXXO..",
  "..OOOOOOOOOOOO..",
  "...OWO....OWO...",
  "...OWO....OWO...",
  "...OOO....OOO...",
  "................",
];

/** A tall bookcase, spines in three colours so it is not a plain wood slab. */
export const BOOKCASE_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OwwwwwwwwwwO..",
  "..OwOOOOOOOOwO..",
  "..OwOnnyyggnOwO.",
  "..OwOnnyyggnOwO.",
  "..OwOOOOOOOOwO..",
  "..OwOqqnnyyqOwO.",
  "..OwOqqnnyyqOwO.",
  "..OwOOOOOOOOwO..",
  "..OwOggqqnnGOwO.",
  "..OwOggqqnnGOwO.",
  "..OwOOOOOOOOwO..",
  "..OwOyynnggyOwO.",
  "..OwOyynnggyOwO.",
  "..OwOOOOOOOOwO..",
  "..OwwwwwwwwwwO..",
  "..OWWWWWWWWWWO..",
  "..OOOOOOOOOOOO..",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

/**
 * The garden's grass checker. Built from the leaf tones rather than a new
 * palette letter - the letter budget is nearly spent, and a lawn is leaf
 * colour by definition.
 */
export const FLOOR_GRASS_A_MAP: SpriteMap = [
  "gggggggggggggggg",
  "ggggggggggGggggg",
  "gggggggggggggggg",
  "ggGggggggggggggg",
  "gggggggggggggggg",
  "ggggggggggggggGg",
  "gggggggggggggggg",
  "gggggGgggggggggg",
  "gggggggggggggggg",
  "ggggggggggggGggg",
  "gggggggggggggggg",
  "gGgggggggggggggg",
  "gggggggggggggggg",
  "ggggggggGggggggg",
  "gggggggggggggggg",
  "ggggggggggggggGg",
];

export const FLOOR_GRASS_B_MAP: SpriteMap = [
  "GGGGGGGGGGGGGGGG",
  "GGGGgGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGgGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GgGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGgGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGgGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGgG",
  "GGGGGGGGGGGGGGGG",
  "GGGgGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGgGGGGGG",
];

/** A tree: round canopy over a short trunk, the trunk on the bottom tile. */
export const TREE_MAP: SpriteMap = [
  "................",
  "................",
  ".....OOOOOO.....",
  "...OOggggggOO...",
  "..OggggGGggggO..",
  ".OggggggggggggO.",
  ".OgggGGggggGggO.",
  "OggggggggggggggO",
  "OggggggggggggggO",
  "OgggGGggggggGGgO",
  "OggggggggggggggO",
  ".OggggggggggggO.",
  ".OgggGGggggGggO.",
  "..OggggggggggO..",
  "...OOggggggOO...",
  ".....OOOOOO.....",
  "................",
  "................",
  ".......OWO......",
  ".......OWO......",
  ".......OWO......",
  ".......OWO......",
  ".......OWO......",
  ".......OWO......",
  ".......OWO......",
  ".......OWO......",
  "......OWWWO.....",
  "......OWWWO.....",
  "......OWWWO.....",
  "......OOOOO.....",
  "................",
  "................",
];

/** A two-seat wooden bench: slats across, legs at both ends. */
export const BENCH_MAP: SpriteMap = [
  "................................",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OWWWWWWWWWWWWWWWWWWWWWWWWWWO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OwwwwwwwwwwwwwwwwwwwwwwwwwwO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OwwwwwwwwwwwwwwwwwwwwwwwwwwO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OwwwwwwwwwwwwwwwwwwwwwwwwwwO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "...OWWO................OWWO.....",
  "...OWWO................OWWO.....",
  "...OOOO................OOOO.....",
  "................................",
  "................................",
  "................................",
];

/** A foosball table: pitch, rods across it, handles out both long sides. */
export const FOOSBALL_MAP: SpriteMap = [
  "................................",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "MMOGGgGGGGGGGGGGGGGGGGGGGGgGGOMM",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "MMOGGGGGGgGGGGGGGGGGGGgGGGGGGOMM",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "MMOGGgGGGGGGGGbGGGGGGGGGGGgGGOMM",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "MMOGGGGGGgGGGGGGGGGGGGgGGGGGGOMM",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "MMOGGgGGGGGGGGGGGGGGGGGGGGgGGOMM",
  "..OGGGGGGGGGGGGGGGGGGGGGGGGGGO..",
  "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
  "...OWWO................OWWO.....",
  "...OOOO................OOOO.....",
];

/** A wall dartboard: concentric rings with one dart in it. */
export const DARTBOARD_MAP: SpriteMap = [
  "................",
  ".....OOOOOO.....",
  "...OObbbbbbOO...",
  "..ObbnnnnnnbbO..",
  ".ObbnnbbbbnnbbO.",
  ".ObnnbbnnbbnnbO.",
  "ObbnbbnnnnbbnbbO",
  "ObbnbnnyynnbnbbO",
  "ObbnbnnyynnbnbbO",
  "ObbnbbnnnnbbnbbO",
  ".ObnnbbnnbbnnbO.",
  ".ObbnnbbbbnnbbO.",
  "..ObbnnnnnnbbO..",
  "...OObbbbbbOO...",
  ".....OOOOOO.....",
  "........OMMO....",
];

/** A small chess table: a checkerboard top, seen from above. */
export const CHESS_TABLE_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OwwwwwwwwwwO..",
  "..OwOOOOOOOOwO..",
  "..OwObBbBbBBOwO.",
  "..OwOBbBbBbbOwO.",
  "..OwObBbBbBBOwO.",
  "..OwOBbBbBbbOwO.",
  "..OwObBbBbBBOwO.",
  "..OwOBbBbBbbOwO.",
  "..OwOOOOOOOOwO..",
  "..OwwwwwwwwwwO..",
  "..OOOOOOOOOOOO..",
  "...OWO....OWO...",
  "...OWO....OWO...",
  "...OOO....OOO...",
  "................",
];

/** A wall-mounted screen: dark panel, lit frame, two colour pixels playing. */
export const TV_MAP: SpriteMap = [
  "................",
  "..OOOOOOOOOOOO..",
  "..OqqqqqqqqqqO..",
  "..OqOOOOOOOOqO..",
  "..OqOddddddOqO..",
  "..OqOdynddddOO..",
  "..OqOddddnyddO..",
  "..OqOddccddddO..",
  "..OqOddddddOqO..",
  "..OqOOOOOOOOqO..",
  "..OqqqqqqqqqqO..",
  "..OOOOOOOOOOOO..",
  "......OMMO......",
  "......OMMO......",
  ".....OMMMMO.....",
  ".....OOOOOO.....",
];

/** A treadmill seen from above: belt between two rails, console at the head. */
export const TREADMILL_MAP: SpriteMap = [
  "..OOOOOOOOOOOO..",
  "..OMMMMMMMMMMO..",
  "..OMOddddddOMO..",
  "..OMOdccccdOMO..",
  "..OMOddddddOMO..",
  "..OMMMMMMMMMMO..",
  "..OOOOOOOOOOOO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOBBBBBBOmO..",
  "..OmOOOOOOOOmO..",
  "..OmmmmmmmmmmO..",
  "..OMMMMMMMMMMO..",
  "..OWWWWWWWWWWO..",
  "..OOOOOOOOOOOO..",
];
