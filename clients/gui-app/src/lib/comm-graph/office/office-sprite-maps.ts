/**
 * The office's art, written as ASCII pixel maps.
 *
 * One character per pixel, `.` transparent, every other letter a color key.
 * Two disjoint key spaces meet here:
 *
 * - FIXED keys resolve through `officePalette(theme)`, so one map renders in
 *   both themes without a second copy.
 * - CHARACTER keys (`S s H h T t P E`) are substituted per agent from its
 *   `OfficeAppearance`, which is why a character map is drawn bald and gets its
 *   hair from a separate overlay: four hair styles times four facings times six
 *   poses would otherwise be ninety-six hand-drawn maps.
 *
 * `O` belongs to both: it is the 1px outline every character and every piece of
 * furniture carries so the silhouette survives a light floor and a dark one.
 * Floor tiles deliberately have none - an outlined tile grid reads as a cage.
 */

/** Rows of equal length, top to bottom. */
export type SpriteMap = ReadonlyArray<string>;

// ---- Character bodies ------------------------------------------------ //
//
// A body is drawn in two halves that compose: a head (rows 0-10) chosen by
// facing, and a torso (rows 11-19) chosen by facing and pose. `left` is never
// authored - the rasterizer mirrors `right`.

const EMPTY_ROW = "................";

const HEAD_DOWN: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSssSSSSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

/** Back of the head: no eyes, no mouth. Hair covers most of it. */
const HEAD_UP: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

/** Three-quarter profile: one eye, a nose bump on the leading edge. */
const HEAD_RIGHT: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSESSO..",
  "..OSSSSSSSSSSsO.",
  "..OSSSSSSSssSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const TORSO_FRONT_STAND: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTsSO.",
  "..OTTTTTTTTTTO..",
  "..OPPPPPPPPPPO..",
  "..OPPPPOOPPPPO..",
  "..OPPPPOOPPPPO..",
  "..OOOOO..OOOOO..",
];

/** Left foot planted, right foot lifted; the near arm swings up a row. */
const TORSO_FRONT_WALK1: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTtTO.",
  ".OTtTTTTTTTTsSO.",
  "..OTTTTTTTTTTO..",
  "..OPPPPPPPPPPO..",
  "..OPPPPOOPPPPO..",
  "..OPPPPOOOOOOO..",
  "..OOOOO.........",
];

const TORSO_FRONT_WALK2: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTsSO.",
  ".OSsTTTTTTTTtTO.",
  "..OTTTTTTTTTTO..",
  "..OPPPPPPPPPPO..",
  "..OPPPPOOPPPPO..",
  "..OOOOOOOPPPPO..",
  ".........OOOOO..",
];

/** Seen from the side the shoulders are narrower and only one hand shows. */
const TORSO_SIDE_STAND: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  "..OTTTTTTTTTTO..",
  "..OTtTTTTTTtTO..",
  "..OTtTTTTTTtTO..",
  "..OTtTTTTTTsSO..",
  "...OTTTTTTTTO...",
  "...OPPPPPPPPO...",
  "...OPPPPPPPPO...",
  "...OPPPPPPPPO...",
  "...OOOOOOOOO....",
];

const TORSO_SIDE_WALK1: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  "..OTTTTTTTTTTO..",
  "..OTtTTTTTTtTO..",
  "..OTtTTTTTTsSO..",
  "..OTtTTTTTTtTO..",
  "...OTTTTTTTTO...",
  "...OPPPPPPPPO...",
  "...OPPPPPPPPO...",
  "..OPPPPOOPPPPO..",
  "..OOOOO...OOOO..",
];

const TORSO_SIDE_WALK2: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  "..OTTTTTTTTTTO..",
  "..OTtTTTTTTtTO..",
  "..OTtTTTTTTtTO..",
  "..OTtTTTTTTsSO..",
  "...OTTTTTTTTO...",
  "...OPPPPPPPPO...",
  "...OPPPPPPPPO...",
  "...OPPPPPPPPO...",
  "...OOOOOOOOO....",
];

// ---- Seated ---------------------------------------------------------- //
//
// Seated maps are whole bodies, not head-plus-torso: the desk hides the legs,
// so the head sits one row lower and the silhouette ends at the chair. The
// three poses differ only in which row carries the hands, which is what makes
// alternating `type1`/`type2` read as typing.

const SEATED_SIT: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTsSO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  EMPTY_ROW,
  EMPTY_ROW,
];

const SEATED_TYPE1: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTsSO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  EMPTY_ROW,
  EMPTY_ROW,
];

const SEATED_TYPE2: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTsSO.",
  ".OTtTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  EMPTY_ROW,
  EMPTY_ROW,
];

export const OFFICE_HEAD_MAPS: ReadonlyArray<{
  readonly label: string;
  readonly map: SpriteMap;
}> = [
  { label: "head-down", map: HEAD_DOWN },
  { label: "head-up", map: HEAD_UP },
  { label: "head-right", map: HEAD_RIGHT },
];

export const OFFICE_TORSO_MAPS: ReadonlyArray<{
  readonly label: string;
  readonly map: SpriteMap;
}> = [
  { label: "torso-front-stand", map: TORSO_FRONT_STAND },
  { label: "torso-front-walk1", map: TORSO_FRONT_WALK1 },
  { label: "torso-front-walk2", map: TORSO_FRONT_WALK2 },
  { label: "torso-side-stand", map: TORSO_SIDE_STAND },
  { label: "torso-side-walk1", map: TORSO_SIDE_WALK1 },
  { label: "torso-side-walk2", map: TORSO_SIDE_WALK2 },
];

export const OFFICE_SEATED_MAPS: ReadonlyArray<{
  readonly label: string;
  readonly map: SpriteMap;
}> = [
  { label: "seated-sit", map: SEATED_SIT },
  { label: "seated-type1", map: SEATED_TYPE1 },
  { label: "seated-type2", map: SEATED_TYPE2 },
];

export function officeHeadMap(facing: "down" | "up" | "right"): SpriteMap {
  if (facing === "up") {
    return HEAD_UP;
  }
  if (facing === "right") {
    return HEAD_RIGHT;
  }
  return HEAD_DOWN;
}

export function officeTorsoMap(
  facing: "down" | "up" | "right",
  pose: "stand" | "walk1" | "walk2",
): SpriteMap {
  if (facing === "right") {
    if (pose === "walk1") {
      return TORSO_SIDE_WALK1;
    }
    if (pose === "walk2") {
      return TORSO_SIDE_WALK2;
    }
    return TORSO_SIDE_STAND;
  }
  if (pose === "walk1") {
    return TORSO_FRONT_WALK1;
  }
  if (pose === "walk2") {
    return TORSO_FRONT_WALK2;
  }
  return TORSO_FRONT_STAND;
}

export function officeSeatedMap(pose: "sit" | "type1" | "type2"): SpriteMap {
  if (pose === "type1") {
    return SEATED_TYPE1;
  }
  if (pose === "type2") {
    return SEATED_TYPE2;
  }
  return SEATED_SIT;
}

// ---- Hair ------------------------------------------------------------ //
//
// A hair map is an overlay: `.` leaves the bald body showing. Every style is
// authored for all three base facings, because a silhouette that only reads
// from the front is useless on a floor where most agents are seated with their
// back to the viewer. The seated poses reuse the `up` maps shifted one row
// down, which is exactly how much lower the seated head sits.

const HAIR_DOWN_SHORT: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHhhhhhhhhHO..",
  "...H........H...",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_DOWN_LONG: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHhhhhhhhhHO..",
  "..OH........HO..",
  "..OH........HO..",
  "..OH........HO..",
  "..OHh......hHO..",
  ".OHh........hHO.",
  ".OHh........hHO.",
  ".OHh........hHO.",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_DOWN_SPIKY: SpriteMap = [
  "....OHO.OHO.....",
  "....OHHHHHHO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHhHhhhhHhHO..",
  "...H........H...",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_DOWN_BUN: SpriteMap = [
  ".....OHHO.......",
  "....OHHHHHHO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHhhhhhhhhHO..",
  "...H........H...",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_UP_SHORT: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHhhhhhhhhHO..",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_UP_LONG: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  ".OHHHHHHHHHHHHO.",
  ".OHHHHHHHHHHHHO.",
  ".OHhhhhhhhhhhHO.",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_UP_SPIKY: SpriteMap = [
  "....OHO.OHO.....",
  "....OHHHHHHO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHhHhhhhHhHO..",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_UP_BUN: SpriteMap = [
  ".....OHHO.......",
  "....OHHHHHHO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHHHHHHHHHHO..",
  "..OHhhhhhhhhHO..",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_RIGHT_SHORT: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHhhhhhhhHO..",
  "..OHh...........",
  "..OHh...........",
  "...H............",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_RIGHT_LONG: SpriteMap = [
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHhhhhhhhHO..",
  "..OHh...........",
  "..OHh...........",
  "..OHh...........",
  "..OHh...........",
  ".OHHh...........",
  ".OHHh...........",
  ".OHHh...........",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_RIGHT_SPIKY: SpriteMap = [
  "....OHO.OHO.....",
  "....OHHHHHHO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHhHhhhhHhO..",
  "..OHh...........",
  "..OHh...........",
  "...H............",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_RIGHT_BUN: SpriteMap = [
  "....OHHO........",
  "....OHHHHHHO....",
  "...OHHHHHHHHO...",
  "..OHHHHHHHHHHO..",
  "..OHHhhhhhhhHO..",
  "..OHh...........",
  "..OHh...........",
  "...H............",
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
];

const HAIR_DOWN: ReadonlyArray<SpriteMap> = [
  HAIR_DOWN_SHORT,
  HAIR_DOWN_LONG,
  HAIR_DOWN_SPIKY,
  HAIR_DOWN_BUN,
];

const HAIR_UP: ReadonlyArray<SpriteMap> = [
  HAIR_UP_SHORT,
  HAIR_UP_LONG,
  HAIR_UP_SPIKY,
  HAIR_UP_BUN,
];

const HAIR_RIGHT: ReadonlyArray<SpriteMap> = [
  HAIR_RIGHT_SHORT,
  HAIR_RIGHT_LONG,
  HAIR_RIGHT_SPIKY,
  HAIR_RIGHT_BUN,
];

export const OFFICE_HAIR_MAPS: ReadonlyArray<{
  readonly label: string;
  readonly map: SpriteMap;
}> = [
  { label: "hair-down-short", map: HAIR_DOWN_SHORT },
  { label: "hair-down-long", map: HAIR_DOWN_LONG },
  { label: "hair-down-spiky", map: HAIR_DOWN_SPIKY },
  { label: "hair-down-bun", map: HAIR_DOWN_BUN },
  { label: "hair-up-short", map: HAIR_UP_SHORT },
  { label: "hair-up-long", map: HAIR_UP_LONG },
  { label: "hair-up-spiky", map: HAIR_UP_SPIKY },
  { label: "hair-up-bun", map: HAIR_UP_BUN },
  { label: "hair-right-short", map: HAIR_RIGHT_SHORT },
  { label: "hair-right-long", map: HAIR_RIGHT_LONG },
  { label: "hair-right-spiky", map: HAIR_RIGHT_SPIKY },
  { label: "hair-right-bun", map: HAIR_RIGHT_BUN },
];

export function officeHairMap(
  facing: "down" | "up" | "right",
  hairStyle: 0 | 1 | 2 | 3,
): SpriteMap {
  const stylesByFacing: Readonly<
    Record<"down" | "up" | "right", ReadonlyArray<SpriteMap>>
  > = { down: HAIR_DOWN, up: HAIR_UP, right: HAIR_RIGHT };
  return stylesByFacing[facing][hairStyle];
}
