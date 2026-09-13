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

// TYPE-ONLY, and the only import this file has: the accessory record below is
// keyed by the scene's own union so the type refuses a member it forgets. The
// import is erased at compile time, so it adds no runtime edge to a module
// that otherwise depends on nothing.
import type { OfficeCharacterAccessory } from "@/lib/comm-graph/office/office-types";

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

/**
 * Tipped back from the desk: the head rides a row higher on a longer neck and
 * both hands come up to the top of the torso. What waiting on somebody else
 * looks like from behind - the one posture that is legible without a face.
 */
const SEATED_LEAN: SpriteMap = [
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
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OSsTTTTTTTTsSO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  EMPTY_ROW,
  EMPTY_ROW,
];

/** An arm up beside the head: this one is asking for a person. */
const SEATED_HAND_UP: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO.O",
  "..OSSSSSSSSSSOSO",
  "...OSSSSSSSSO.SO",
  ".....OSSSSO..OSO",
  ".OTTTTTTTTTTTTSO",
  ".OTtTTTTTTTTTTsO",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  EMPTY_ROW,
  EMPTY_ROW,
];

/**
 * Head in hands, a row lower than usual. Paired with the crashed screen at the
 * same desk, which is what says whether the slump is a failure or a long day.
 */
const SEATED_CRASH: SpriteMap = [
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  "..OSsOSSSSOsSO..",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  EMPTY_ROW,
  EMPTY_ROW,
];

// ---- Accessories ----------------------------------------------------- //
//
// Worn OVER a finished body rather than authored into one, because the body
// underneath keeps changing: an agent working in the background still types.
// Aligned to the STANDING head, like the hair maps, and shifted down by the
// same amount for a seated pose.

const HEADPHONES: SpriteMap = [
  "...OOOOOOOOOO...",
  "..OEEEEEEEEEEO..",
  "..OEO......OEO..",
  "..OEO......OEO..",
  "..OEO......OEO..",
  "..OEO......OEO..",
  "..OEO......OEO..",
  "...O........O...",
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

const SEATED_SIT_DOWN: SpriteMap = [
  "................",
  "................",
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  "....OSSSSSSO....",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTsSO.",
  ".OTTTTTTTTTTTTO.",
  "..OPPPPPPPPPPO..",
  "..OPPPP..PPPPO..",
  "...OPPO..OPPO...",
  "...OOOO..OOOO...",
  "................",
  "................",
];

const SEATED_TYPE1_DOWN: SpriteMap = [
  "................",
  "................",
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  "....OSSSSSSO....",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OSsTTTTTTTTtTO.",
  ".OTtTTTTTTTTsSO.",
  ".OTTTTTTTTTTTTO.",
  "..OPPPPPPPPPPO..",
  "..OPPPP..PPPPO..",
  "...OPPO..OPPO...",
  "...OOOO..OOOO...",
  "................",
  "................",
];

const SEATED_TYPE2_DOWN: SpriteMap = [
  "................",
  "................",
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  "....OSSSSSSO....",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTsSO.",
  ".OSsTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  "..OPPPPPPPPPPO..",
  "..OPPPP..PPPPO..",
  "...OPPO..OPPO...",
  "...OOOO..OOOO...",
  "................",
  "................",
];

const SEATED_LEAN_DOWN: SpriteMap = [
  "................",
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  ".....OSSSSO.....",
  ".....OSSSSO.....",
  ".OTTTTTTTTTTTTO.",
  ".OSsTTTTTTTTsSO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  "................",
  "................",
];

const SEATED_HAND_UP_DOWN: SpriteMap = [
  "................",
  "................",
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO.O",
  "..OSSSSSSSSSSOSO",
  "...OSSSSSSSSO.SO",
  ".....OSSSSO..OSO",
  ".OTTTTTTTTTTTTSO",
  ".OTtTTTTTTTTTTsO",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OSsTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  "................",
  "................",
];

const SEATED_CRASH_DOWN: SpriteMap = [
  "................",
  "................",
  "................",
  "....OOOOOOOO....",
  "...OSSSSSSSSO...",
  "..OSSSSSSSSSSO..",
  "..OSSESSSSESSO..",
  "..OSSSSSSSSSSO..",
  "..OSSSSSSSSSSO..",
  "...OSSSSSSSSO...",
  "..OSsOSSSSOsSO..",
  ".OTTTTTTTTTTTTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTtTTTTTTTTtTO.",
  ".OTTTTTTTTTTTTO.",
  ".OOOOOOOOOOOOOO.",
  "................",
  "................",
];

export const OFFICE_SEATED_MAPS: ReadonlyArray<{
  readonly facing: "up" | "down";
  readonly label: string;
  readonly map: SpriteMap;
}> = [
  { label: "seated-sit", facing: "up", map: SEATED_SIT },
  { label: "seated-type1", facing: "up", map: SEATED_TYPE1 },
  { label: "seated-type2", facing: "up", map: SEATED_TYPE2 },
  { label: "seated-lean", facing: "up", map: SEATED_LEAN },
  { label: "seated-hand-up", facing: "up", map: SEATED_HAND_UP },
  { label: "seated-crash", facing: "up", map: SEATED_CRASH },
  { label: "seated-sit-down", facing: "down", map: SEATED_SIT_DOWN },
  { label: "seated-type1-down", facing: "down", map: SEATED_TYPE1_DOWN },
  { label: "seated-type2-down", facing: "down", map: SEATED_TYPE2_DOWN },
  { label: "seated-lean-down", facing: "down", map: SEATED_LEAN_DOWN },
  { label: "seated-hand-up-down", facing: "down", map: SEATED_HAND_UP_DOWN },
  { label: "seated-crash-down", facing: "down", map: SEATED_CRASH_DOWN },
];

/**
 * Every accessory the office draws, keyed by the name the scene asks for.
 *
 * THE ONE SOURCE. The enumerated list and the lookup below are both derived
 * from this, because they used to be written out separately: add an accessory
 * to only one and either `officeAccessoryMap` cannot resolve it or
 * `officeSpriteMaps()` stops enumerating it, and the sprite-completeness test
 * still passes - it only walks what it is handed. Keying on
 * `OfficeCharacterAccessory` rather than on a local union is the other half:
 * the type now refuses a member this record forgets, so the drift is a compile
 * error instead of a missing sprite.
 */
export const OFFICE_ACCESSORY_MAPS_BY_NAME: Readonly<
  Record<OfficeCharacterAccessory, SpriteMap>
> = {
  headphones: HEADPHONES,
};

export const OFFICE_ACCESSORY_MAPS: ReadonlyArray<{
  readonly label: string;
  readonly map: SpriteMap;
}> = Object.entries(OFFICE_ACCESSORY_MAPS_BY_NAME).map(([name, map]) => ({
  label: `accessory-${name}`,
  map,
}));

/** Every seated pose the office draws, and how far its HEAD sits from the top. */
export type OfficeSeatedPose =
  | "sit"
  | "type1"
  | "type2"
  | "lean"
  | "hand-up"
  | "crash";

export function isOfficeSeatedPose(pose: string): pose is OfficeSeatedPose {
  return (
    pose === "sit" ||
    pose === "type1" ||
    pose === "type2" ||
    pose === "lean" ||
    pose === "hand-up" ||
    pose === "crash"
  );
}

/**
 * How far an overlay authored for the STANDING head has to drop to land on
 * this pose's head. A seated head sits one row lower than a standing one; a
 * lean tips it back up, and a slump drops it further.
 */
export function officeHeadOffsetOf(pose: OfficeSeatedPose): number {
  if (pose === "lean") return 0;
  if (pose === "crash") return 2;
  return 1;
}

export function officeAccessoryMap(
  accessory: OfficeCharacterAccessory,
): SpriteMap {
  return OFFICE_ACCESSORY_MAPS_BY_NAME[accessory];
}

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

export function officeSeatedMap(
  pose: OfficeSeatedPose,
  facing: "up" | "down",
): SpriteMap {
  if (facing === "down") {
    if (pose === "type1") return SEATED_TYPE1_DOWN;
    if (pose === "type2") return SEATED_TYPE2_DOWN;
    if (pose === "lean") return SEATED_LEAN_DOWN;
    if (pose === "hand-up") return SEATED_HAND_UP_DOWN;
    if (pose === "crash") return SEATED_CRASH_DOWN;
    return SEATED_SIT_DOWN;
  }
  if (pose === "type1") {
    return SEATED_TYPE1;
  }
  if (pose === "type2") {
    return SEATED_TYPE2;
  }
  if (pose === "lean") {
    return SEATED_LEAN;
  }
  if (pose === "hand-up") {
    return SEATED_HAND_UP;
  }
  if (pose === "crash") {
    return SEATED_CRASH;
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
