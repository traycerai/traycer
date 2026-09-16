/**
 * Rasterizes the office's ASCII pixel maps and draws them.
 *
 * A map is art; this module is the only place that turns one into pixels. Two
 * halves, deliberately separable:
 *
 * - `rasterizeSpriteMap` is pure and DOM-free, so the art can be asserted on
 *   without a canvas implementation.
 * - `drawOfficeSprite` caches one offscreen surface per distinct rasterization
 *   and does nothing but `drawImage` per call, so a floor of forty characters
 *   costs forty blits per frame and no per-pixel work at all.
 *
 * The cache key spans every input that changes a pixel - name, facing, pose,
 * the agent's appearance, the tint and the theme - because a stale entry would
 * silently render one agent in another's colors.
 */
import {
  OFFICE_TILE,
  type OfficePoint,
  type OfficeSize,
  type OfficeSpriteName,
  type OfficeSpriteRef,
  type OfficeTheme,
  type OfficeVehicleKind,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeViewId } from "@/lib/comm-graph/office/office-view-vocabulary";
import {
  BOX_MAP,
  FACE_MAP,
  SLAB_MAP,
  DESK_FRONT_MAP,
  LAMP_MAP,
  STAIRS_SIDE_MAP,
  CUBBY_MAP,
  SILHOUETTE_MAP,
  SKYBRIDGE_MAP,
  BOARD_MAP,
  ROOF_EDGE_MAP,
  BUBBLE_ATTENTION_MAP,
  BUBBLE_AWAITING_MAP,
  BUBBLE_HELLO_MAP,
  BUBBLE_NOTICE_MAP,
  BUBBLE_SLEEP_MAP,
  ARCADE_MAP,
  ARMCHAIR_MAP,
  BENCH_MAP,
  BIN_MAP,
  BOOKCASE_MAP,
  CHESS_TABLE_MAP,
  DARTBOARD_MAP,
  FLOOR_POD_A_MAP,
  FLOOR_POD_B_MAP,
  FLOOR_GRASS_A_MAP,
  FLOOR_GRASS_B_MAP,
  FLOOR_POD_WARM_A_MAP,
  FLOOR_POD_WARM_B_MAP,
  CAFE_TABLE_MAP,
  CHAIR_MAP,
  CLOCK_MAP,
  COFFEE_MACHINE_MAP,
  CONSOLE_MAP,
  DESK_MAP,
  DOOR_MAP,
  DUST_SHEET_MAP,
  ENVELOPE_MAP,
  ENVELOPE_STACK_1_MAP,
  ENVELOPE_STACK_2_MAP,
  ENVELOPE_STACK_3_MAP,
  FLOOR_A_MAP,
  FLOOR_B_MAP,
  MENU_BOARD_MAP,
  MONITOR_CRASH_MAP,
  MONITOR_OFF_MAP,
  MONITOR_ON_B_MAP,
  MONITOR_ON_MAP,
  MONITOR_SMALL_OFF_MAP,
  MONITOR_SMALL_ON_MAP,
  MONITOR_WIDE_OFF_MAP,
  MONITOR_WIDE_ON_B_MAP,
  MONITOR_WIDE_ON_MAP,
  NAMEPLATE_MAP,
  PARTITION_MAP,
  PLANT_MAP,
  PODIUM_MAP,
  RECEPTION_MAP,
  RUG_MAP,
  SIGN_MAP,
  SPARKLE_MAP,
  STAIRS_MAP,
  VENDING_MAP,
  WALL_MAP,
  WALL_TOP_MAP,
  PAPER_BALL_MAP,
  PARTITION_H_MAP,
  FOOSBALL_MAP,
  PLANTER_MAP,
  POD_PLATE_MAP,
  PINGPONG_TABLE_MAP,
  SHELF_H_MAP,
  SHELF_MAP,
  SLEEP_BAG_MAP,
  SOFA_MAP,
  TIER_STEP_MAP,
  TREADMILL_MAP,
  TREE_MAP,
  TV_MAP,
  WATER_COOLER_MAP,
  WATERING_CAN_MAP,
  WHITEBOARD_MAP,
  WINDOW_MAP,
  BLOCK_LEFT_MAP,
  BLOCK_RIGHT_MAP,
  BLOCK_TOP_MAP,
  DESK_ISO_MAP,
  DOOR_ISO_MAP,
  FLOOR_GRASS_ISO_A_MAP,
  FLOOR_GRASS_ISO_B_MAP,
  FLOOR_ISO_A_MAP,
  FLOOR_ISO_B_MAP,
  SPIRE_MAP,
  WALL_ISO_LEFT_MAP,
  WALL_ISO_RIGHT_MAP,
  WINDOW_DARK_MAP,
  WINDOW_LIT_MAP,
  BED_MAP,
  BED_OCCUPIED_MAP,
  LOUNGE_CHAIR_MAP,
  LOW_TABLE_MAP,
  RECORDS_DOOR_MAP,
  CROSS_SIGN_MAP,
  // ---- K2: the five other views' civic art -------------------------- //
  GLASS_PARTITION_MAP,
  SIREN_LIGHT_MAP,
  SIREN_LIGHT_B_MAP,
  BED_ISO_MAP,
  LOUNGE_CHAIR_ISO_MAP,
  HOSPITAL_ROOF_CROSS_MAP,
  BUS_SHELTER_MAP,
  WAREHOUSE_DOOR_ISO_MAP,
  MEDBAY_BED_MAP,
  GALLERY_SEAT_MAP,
  // ---- K3: the three civic vehicles --------------------------------- //
  AMBULANCE_MAP,
  AMBULANCE_B_MAP,
  AMBULANCE_ISO_MAP,
  AMBULANCE_ISO_B_MAP,
  POLICE_CAR_MAP,
  POLICE_CAR_B_MAP,
  POLICE_CAR_ISO_MAP,
  POLICE_CAR_ISO_B_MAP,
  FIRE_ENGINE_MAP,
  FIRE_ENGINE_B_MAP,
  FIRE_ENGINE_ISO_MAP,
  FIRE_ENGINE_ISO_B_MAP,
} from "@/lib/comm-graph/office/office-prop-maps";
import {
  isOfficeSeatedPose,
  officeAccessoryMap,
  officeHairMap,
  officeHeadMap,
  officeHeadOffsetOf,
  officeSeatedMap,
  officeTorsoMap,
  OFFICE_ACCESSORY_MAPS,
  OFFICE_HAIR_MAPS,
  OFFICE_HEAD_MAPS,
  OFFICE_SEATED_MAPS,
  OFFICE_TORSO_MAPS,
  type SpriteMap,
} from "@/lib/comm-graph/office/office-sprite-maps";

export type { SpriteMap };

/** A rasterized map as straight RGBA, four bytes per pixel, row-major. */
export interface RasterizedSprite {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/**
 * The theme-dependent half of the art's color space. Character colors are NOT
 * here: an agent looks the same in both themes, which is what makes an agent
 * recognizable to someone who switches theme mid-session.
 */
export interface OfficePalette {
  readonly floorBase: string;
  readonly floorAccent: string;
  readonly wallLight: string;
  readonly wallDark: string;
  readonly woodLight: string;
  readonly woodDark: string;
  readonly metalLight: string;
  readonly metalDark: string;
  readonly screenLit: string;
  readonly screenDark: string;
  /** Frosted partition glass; the two tones split one pane down the middle. */
  readonly glassLight: string;
  readonly glassDark: string;
  readonly leafLight: string;
  readonly leafDark: string;
  readonly rugBase: string;
  readonly rugBorder: string;
  readonly sky: string;
  readonly bright: string;
  readonly ink: string;
  readonly attention: string;
  readonly notice: string;
  readonly outline: string;
  /** Fallback for `Z` when a ref carries no tint. */
  readonly tintDefault: string;
  /** Room background behind the floor, and the label colors over it. */
  readonly background: string;
  readonly text: string;
  readonly textMuted: string;
  /** Drop shadows; the caller owns the alpha it draws this at. */
  readonly shadow: string;
}

const DARK_PALETTE: OfficePalette = {
  floorBase: "#2b3138",
  floorAccent: "#313841",
  wallLight: "#3a4149",
  wallDark: "#2e343b",
  woodLight: "#8a6a45",
  woodDark: "#5f4830",
  metalLight: "#7b838d",
  metalDark: "#545c66",
  screenLit: "#2f6f8f",
  screenDark: "#1d2228",
  glassLight: "#6b8494",
  glassDark: "#4e626f",
  leafLight: "#4f8f5f",
  leafDark: "#376a45",
  rugBase: "#3a3140",
  rugBorder: "#4a3f52",
  sky: "#4a7fb5",
  bright: "#f2f4f7",
  ink: "#21262c",
  attention: "#e3b341",
  notice: "#e06c60",
  outline: "#14171b",
  tintDefault: "#d8dde3",
  background: "#22262b",
  text: "#e6e9ed",
  textMuted: "#98a1ab",
  shadow: "#000000",
};

const LIGHT_PALETTE: OfficePalette = {
  floorBase: "#cfd8c4",
  floorAccent: "#c6d0ba",
  wallLight: "#efe6d2",
  wallDark: "#ddd0b8",
  woodLight: "#c9a26b",
  woodDark: "#8a6b3c",
  metalLight: "#b9c0c8",
  metalDark: "#8d959e",
  screenLit: "#7fd6ff",
  screenDark: "#c3cad1",
  glassLight: "#dfeef5",
  glassDark: "#bcd6e2",
  leafLight: "#6fae72",
  leafDark: "#4a8455",
  rugBase: "#d8c8b4",
  rugBorder: "#c0ab92",
  sky: "#9fd4f5",
  bright: "#ffffff",
  ink: "#2a2f36",
  attention: "#ffd86b",
  notice: "#ff9d90",
  outline: "#3b3630",
  tintDefault: "#6b6154",
  background: "#e6ded0",
  text: "#2a2f36",
  textMuted: "#6f7681",
  shadow: "#4a4438",
};

export function officePalette(theme: OfficeTheme): OfficePalette {
  return theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

/** Fixed map letters, and the palette entry each resolves to. */
const PALETTE_LETTERS: ReadonlyMap<string, keyof OfficePalette> = new Map([
  ["O", "outline"],
  ["w", "woodLight"],
  ["W", "woodDark"],
  ["m", "metalLight"],
  ["M", "metalDark"],
  ["c", "screenLit"],
  ["d", "screenDark"],
  ["v", "glassLight"],
  ["V", "glassDark"],
  ["g", "leafLight"],
  ["G", "leafDark"],
  ["f", "floorBase"],
  ["F", "floorAccent"],
  ["l", "wallLight"],
  ["L", "wallDark"],
  ["b", "bright"],
  ["B", "ink"],
  ["y", "attention"],
  ["n", "notice"],
  ["x", "rugBase"],
  ["X", "rugBorder"],
  ["q", "sky"],
]);

/** Substituted per agent; `E` and the tint `Z` are handled alongside them. */
const APPEARANCE_LETTERS: ReadonlyArray<string> = [
  "S",
  "s",
  "H",
  "h",
  "T",
  "t",
  "P",
  "E",
];

/** Every letter a map may use besides `.`. The art test asserts against this. */
export const OFFICE_SPRITE_LETTERS: ReadonlySet<string> = new Set([
  ...PALETTE_LETTERS.keys(),
  ...APPEARANCE_LETTERS,
  "Z",
]);

/** Eyes never take a theme or an appearance - a light iris reads as a stare. */
const EYE_COLOR = "#20242c";

const SPRITE_SIZES: Readonly<Record<OfficeSpriteName, OfficeSize>> = {
  character: { width: 16, height: 20 },
  face: { width: 16, height: 16 },
  slab: { width: 16, height: 16 },
  "desk-front": { width: 32, height: 16 },
  lamp: { width: 8, height: 8 },
  "stairs-side": { width: 16, height: 16 },
  cubby: { width: 16, height: 16 },
  silhouette: { width: 16, height: 16 },
  skybridge: { width: 16, height: 16 },
  board: { width: 16, height: 12 },
  "roof-edge": { width: 16, height: 8 },

  desk: { width: 32, height: 16 },
  "monitor-on": { width: 16, height: 12 },
  "monitor-on-b": { width: 16, height: 12 },
  "monitor-off": { width: 16, height: 12 },
  nameplate: { width: 12, height: 6 },
  partition: { width: 16, height: 16 },
  sign: { width: 32, height: 16 },
  "monitor-small-on": { width: 12, height: 9 },
  "monitor-small-off": { width: 12, height: 9 },
  "monitor-wide-on": { width: 24, height: 12 },
  "monitor-wide-on-b": { width: 24, height: 12 },
  "monitor-wide-off": { width: 24, height: 12 },
  "monitor-crash": { width: 16, height: 12 },
  "envelope-stack-1": { width: 10, height: 6 },
  "envelope-stack-2": { width: 10, height: 8 },
  "envelope-stack-3": { width: 10, height: 10 },
  clock: { width: 12, height: 12 },
  "dust-sheet": { width: 32, height: 16 },
  box: { width: 16, height: 16 },
  reception: { width: 32, height: 16 },
  stairs: { width: 32, height: 32 },
  "water-cooler": { width: 16, height: 24 },
  "cafe-table": { width: 32, height: 16 },
  sofa: { width: 32, height: 16 },
  bin: { width: 16, height: 16 },
  "paper-ball": { width: 4, height: 4 },
  "watering-can": { width: 8, height: 8 },
  "pingpong-table": { width: 32, height: 16 },
  arcade: { width: 16, height: 24 },
  "floor-pod-a": { width: 16, height: 16 },
  "floor-pod-b": { width: 16, height: 16 },
  "partition-h": { width: 16, height: 16 },
  "pod-plate": { width: 16, height: 8 },
  "sleep-bag": { width: 16, height: 24 },
  armchair: { width: 16, height: 16 },
  bookcase: { width: 16, height: 24 },
  "floor-grass-a": { width: 16, height: 16 },
  "floor-grass-b": { width: 16, height: 16 },
  tree: { width: 16, height: 32 },
  bench: { width: 32, height: 16 },
  foosball: { width: 32, height: 16 },
  dartboard: { width: 16, height: 16 },
  "chess-table": { width: 16, height: 16 },
  tv: { width: 16, height: 16 },
  treadmill: { width: 16, height: 24 },
  "floor-pod-warm-a": { width: 16, height: 16 },
  "floor-pod-warm-b": { width: 16, height: 16 },
  planter: { width: 16, height: 16 },
  shelf: { width: 16, height: 16 },
  "shelf-h": { width: 16, height: 16 },
  vending: { width: 16, height: 24 },
  "menu-board": { width: 32, height: 16 },
  chair: { width: 16, height: 16 },
  plant: { width: 16, height: 24 },
  "floor-a": { width: 16, height: 16 },
  "floor-b": { width: 16, height: 16 },
  rug: { width: 32, height: 32 },
  wall: { width: 16, height: 16 },
  "wall-top": { width: 16, height: 16 },
  door: { width: 16, height: 16 },
  window: { width: 16, height: 16 },
  whiteboard: { width: 32, height: 16 },
  "coffee-machine": { width: 16, height: 24 },
  envelope: { width: 10, height: 8 },
  "bubble-awaiting": { width: 14, height: 12 },
  "bubble-attention": { width: 14, height: 12 },
  "bubble-notice": { width: 14, height: 12 },
  "bubble-hello": { width: 14, height: 12 },
  "bubble-sleep": { width: 14, height: 12 },
  sparkle: { width: 8, height: 8 },
  "tier-step": { width: 16, height: 16 },
  podium: { width: 32, height: 16 },
  console: { width: 32, height: 16 },
  "floor-iso-a": { width: 32, height: 16 },
  "floor-iso-b": { width: 32, height: 16 },
  "floor-grass-iso-a": { width: 32, height: 16 },
  "floor-grass-iso-b": { width: 32, height: 16 },
  "wall-iso-left": { width: 16, height: 32 },
  "wall-iso-right": { width: 16, height: 32 },
  "door-iso": { width: 16, height: 32 },
  "desk-iso": { width: 32, height: 24 },
  "block-left": { width: 16, height: 16 },
  "block-right": { width: 16, height: 16 },
  "block-top": { width: 32, height: 16 },
  "window-lit": { width: 8, height: 8 },
  "window-dark": { width: 8, height: 8 },
  spire: { width: 8, height: 24 },

  // The civic vehicles: two tiles of road in oblique, a wider three-quarter
  // box in isometric, each in two light frames.
  ambulance: { width: 32, height: 16 },
  "ambulance-b": { width: 32, height: 16 },
  "ambulance-iso": { width: 40, height: 24 },
  "ambulance-iso-b": { width: 40, height: 24 },
  "police-car": { width: 32, height: 16 },
  "police-car-b": { width: 32, height: 16 },
  "police-car-iso": { width: 40, height: 24 },
  "police-car-iso-b": { width: 40, height: 24 },
  "fire-engine": { width: 32, height: 16 },
  "fire-engine-b": { width: 32, height: 16 },
  "fire-engine-iso": { width: 40, height: 24 },
  "fire-engine-iso-b": { width: 40, height: 24 },

  bed: { width: 32, height: 16 },
  "bed-occupied": { width: 32, height: 16 },
  "lounge-chair": { width: 16, height: 16 },
  "low-table": { width: 32, height: 16 },
  "records-door": { width: 16, height: 16 },
  "cross-sign": { width: 16, height: 16 },

  // ---- K2: the five other views' civic art -------------------------- //
  "glass-partition": { width: 16, height: 16 },
  "siren-light": { width: 8, height: 8 },
  "siren-light-b": { width: 8, height: 8 },
  "bed-iso": { width: 32, height: 24 },
  "lounge-chair-iso": { width: 16, height: 16 },
  "hospital-roof-cross": { width: 32, height: 16 },
  "bus-shelter": { width: 32, height: 24 },
  "warehouse-door-iso": { width: 16, height: 32 },
  "medbay-bed": { width: 32, height: 16 },
  "gallery-seat": { width: 16, height: 16 },
};

const PROP_MAPS: Readonly<Record<OfficeSpriteName, SpriteMap>> = {
  character: [],
  desk: DESK_MAP,
  face: FACE_MAP,
  slab: SLAB_MAP,
  "desk-front": DESK_FRONT_MAP,
  lamp: LAMP_MAP,
  "stairs-side": STAIRS_SIDE_MAP,
  cubby: CUBBY_MAP,
  silhouette: SILHOUETTE_MAP,
  skybridge: SKYBRIDGE_MAP,
  board: BOARD_MAP,
  "roof-edge": ROOF_EDGE_MAP,

  "monitor-on": MONITOR_ON_MAP,
  "monitor-on-b": MONITOR_ON_B_MAP,
  "monitor-off": MONITOR_OFF_MAP,
  nameplate: NAMEPLATE_MAP,
  partition: PARTITION_MAP,
  sign: SIGN_MAP,
  "monitor-small-on": MONITOR_SMALL_ON_MAP,
  "monitor-small-off": MONITOR_SMALL_OFF_MAP,
  "monitor-wide-on": MONITOR_WIDE_ON_MAP,
  "monitor-wide-on-b": MONITOR_WIDE_ON_B_MAP,
  "monitor-wide-off": MONITOR_WIDE_OFF_MAP,
  "monitor-crash": MONITOR_CRASH_MAP,
  "envelope-stack-1": ENVELOPE_STACK_1_MAP,
  "envelope-stack-2": ENVELOPE_STACK_2_MAP,
  "envelope-stack-3": ENVELOPE_STACK_3_MAP,
  clock: CLOCK_MAP,
  "dust-sheet": DUST_SHEET_MAP,
  box: BOX_MAP,
  reception: RECEPTION_MAP,
  stairs: STAIRS_MAP,
  "water-cooler": WATER_COOLER_MAP,
  "cafe-table": CAFE_TABLE_MAP,
  sofa: SOFA_MAP,
  bin: BIN_MAP,
  "paper-ball": PAPER_BALL_MAP,
  "watering-can": WATERING_CAN_MAP,
  "pingpong-table": PINGPONG_TABLE_MAP,
  arcade: ARCADE_MAP,
  "floor-pod-a": FLOOR_POD_A_MAP,
  "floor-pod-b": FLOOR_POD_B_MAP,
  "partition-h": PARTITION_H_MAP,
  "pod-plate": POD_PLATE_MAP,
  "sleep-bag": SLEEP_BAG_MAP,
  armchair: ARMCHAIR_MAP,
  bookcase: BOOKCASE_MAP,
  "floor-grass-a": FLOOR_GRASS_A_MAP,
  "floor-grass-b": FLOOR_GRASS_B_MAP,
  tree: TREE_MAP,
  bench: BENCH_MAP,
  foosball: FOOSBALL_MAP,
  dartboard: DARTBOARD_MAP,
  "chess-table": CHESS_TABLE_MAP,
  tv: TV_MAP,
  treadmill: TREADMILL_MAP,
  "floor-pod-warm-a": FLOOR_POD_WARM_A_MAP,
  "floor-pod-warm-b": FLOOR_POD_WARM_B_MAP,
  planter: PLANTER_MAP,
  shelf: SHELF_MAP,
  "shelf-h": SHELF_H_MAP,
  vending: VENDING_MAP,
  "menu-board": MENU_BOARD_MAP,
  chair: CHAIR_MAP,
  plant: PLANT_MAP,
  "floor-a": FLOOR_A_MAP,
  "floor-b": FLOOR_B_MAP,
  rug: RUG_MAP,
  wall: WALL_MAP,
  "wall-top": WALL_TOP_MAP,
  door: DOOR_MAP,
  window: WINDOW_MAP,
  whiteboard: WHITEBOARD_MAP,
  "coffee-machine": COFFEE_MACHINE_MAP,
  envelope: ENVELOPE_MAP,
  "bubble-awaiting": BUBBLE_AWAITING_MAP,
  "bubble-attention": BUBBLE_ATTENTION_MAP,
  "bubble-notice": BUBBLE_NOTICE_MAP,
  "bubble-hello": BUBBLE_HELLO_MAP,
  "bubble-sleep": BUBBLE_SLEEP_MAP,
  sparkle: SPARKLE_MAP,
  "tier-step": TIER_STEP_MAP,
  podium: PODIUM_MAP,
  console: CONSOLE_MAP,
  "floor-iso-a": FLOOR_ISO_A_MAP,
  "floor-iso-b": FLOOR_ISO_B_MAP,
  "floor-grass-iso-a": FLOOR_GRASS_ISO_A_MAP,
  "floor-grass-iso-b": FLOOR_GRASS_ISO_B_MAP,
  "wall-iso-left": WALL_ISO_LEFT_MAP,
  "wall-iso-right": WALL_ISO_RIGHT_MAP,
  "door-iso": DOOR_ISO_MAP,
  "desk-iso": DESK_ISO_MAP,
  "block-left": BLOCK_LEFT_MAP,
  "block-right": BLOCK_RIGHT_MAP,
  "block-top": BLOCK_TOP_MAP,
  "window-lit": WINDOW_LIT_MAP,
  "window-dark": WINDOW_DARK_MAP,
  spire: SPIRE_MAP,

  bed: BED_MAP,
  "bed-occupied": BED_OCCUPIED_MAP,
  "lounge-chair": LOUNGE_CHAIR_MAP,
  "low-table": LOW_TABLE_MAP,
  "records-door": RECORDS_DOOR_MAP,
  "cross-sign": CROSS_SIGN_MAP,

  // ---- K2: the five other views' civic art -------------------------- //
  "glass-partition": GLASS_PARTITION_MAP,
  "siren-light": SIREN_LIGHT_MAP,
  "siren-light-b": SIREN_LIGHT_B_MAP,
  "bed-iso": BED_ISO_MAP,
  "lounge-chair-iso": LOUNGE_CHAIR_ISO_MAP,
  "hospital-roof-cross": HOSPITAL_ROOF_CROSS_MAP,
  "bus-shelter": BUS_SHELTER_MAP,
  "warehouse-door-iso": WAREHOUSE_DOOR_ISO_MAP,
  "medbay-bed": MEDBAY_BED_MAP,
  "gallery-seat": GALLERY_SEAT_MAP,

  // ---- K3: the three civic vehicles --------------------------------- //
  ambulance: AMBULANCE_MAP,
  "ambulance-b": AMBULANCE_B_MAP,
  "ambulance-iso": AMBULANCE_ISO_MAP,
  "ambulance-iso-b": AMBULANCE_ISO_B_MAP,
  "police-car": POLICE_CAR_MAP,
  "police-car-b": POLICE_CAR_B_MAP,
  "police-car-iso": POLICE_CAR_ISO_MAP,
  "police-car-iso-b": POLICE_CAR_ISO_B_MAP,
  "fire-engine": FIRE_ENGINE_MAP,
  "fire-engine-b": FIRE_ENGINE_B_MAP,
  "fire-engine-iso": FIRE_ENGINE_ISO_MAP,
  "fire-engine-iso-b": FIRE_ENGINE_ISO_B_MAP,
};

/**
 * The sprites whose `left` facing is drawn by MIRRORING their `right`.
 *
 * `character` has always done this (see `selectCharacterMap`); vehicles are the
 * first props to, because a road runs both ways and authoring a second copy of
 * each van is the drift `officeHairMap` was built to avoid. Every other prop
 * ignores a ref's `facing` entirely and resolves `mirror: false`, which is what
 * keeps this a named exception rather than a new rule for props at large.
 */
const MIRRORED_PROP_NAMES: ReadonlySet<string> = new Set<OfficeSpriteName>([
  "ambulance",
  "ambulance-b",
  "ambulance-iso",
  "ambulance-iso-b",
  "police-car",
  "police-car-b",
  "police-car-iso",
  "police-car-iso-b",
  "fire-engine",
  "fire-engine-b",
  "fire-engine-iso",
  "fire-engine-iso-b",
]);

/**
 * WHICH VEHICLE ART A VIEW USES.
 *
 * A view draws its vans the way it draws everything else, and the two answers
 * are the two projections the office has: a side view for the views whose
 * ground is axis-aligned, a three-quarter view for the two that are seen from
 * the corner. Mission control has no road at all (decision C6) and its entry is
 * therefore never read - it is here because the record is exhaustive over the
 * view union, which is what makes adding a seventh view a compile error rather
 * than a silently missing sprite.
 */
export type OfficeVehicleArt = "oblique" | "isometric";

export const OFFICE_VEHICLE_ART: Readonly<
  Record<OfficeViewId, OfficeVehicleArt>
> = {
  floor: "oblique",
  towers: "oblique",
  building: "oblique",
  "mission-control": "oblique",
  campus: "isometric",
  city: "isometric",
};

/**
 * The sprite one vehicle wears this frame.
 *
 * Three facts pick it and the facing is not among them: `left` is the mirror of
 * `right`, so the ref carries the facing and the rasterizer does the flip.
 */
export function officeVehicleSpriteName(args: {
  readonly kind: OfficeVehicleKind;
  readonly art: OfficeVehicleArt;
  readonly lights: 0 | 1;
}): OfficeSpriteName {
  const projection = args.art === "isometric" ? "-iso" : "";
  const frame = args.lights === 1 ? "-b" : "";
  const name = `${args.kind}${projection}${frame}`;
  if (!isPropSpriteName(name)) {
    throw new Error(`office: no vehicle sprite named ${name}`);
  }
  return name;
}

/**
 * Narrows a key of {@link PROP_MAPS} back to its own key type.
 *
 * `Object.keys` erases to `string[]`, and a cast to put the type back would
 * re-introduce exactly the drift the derivation below exists to remove.
 */
function isPropSpriteName(name: string): name is OfficeSpriteName {
  return Object.hasOwn(PROP_MAPS, name);
}

/**
 * Every name that has a single authored map, i.e. everything but `character`.
 *
 * DERIVED from the maps rather than listed beside them. The art-shape test
 * reads this list, so a hand-written copy meant a new sprite could be authored,
 * drawn, shipped and never once checked - the test would pass by not looking.
 */
const PROP_SPRITE_NAMES: ReadonlyArray<OfficeSpriteName> = Object.keys(
  PROP_MAPS,
)
  .filter(isPropSpriteName)
  .filter((name) => name !== "character");

export function officeSpriteSize(ref: OfficeSpriteRef): OfficeSize {
  return SPRITE_SIZES[ref.name];
}

/**
 * Where a TOP-LEFT anchored sprite is drawn so that its FOOT lands on a tile.
 *
 * A prop taller than its tile would otherwise spill DOWN over whatever sits on
 * the row below - a plant over its own chair, a rug over the doorway. A
 * one-tile sprite is unaffected, and a sprite SHORTER than a tile (a name
 * plate, a pod plate) sits down on it, which is where a small thing on the
 * floor actually is.
 *
 * Lives with the sprite sizes rather than with any one caller: the painter
 * places props by it, the scene hangs the clock hands off it, and the renderer
 * mounts a sign with it. Three copies of this arithmetic is three chances for
 * one of them to disagree about where a sign is.
 */
export function officeSpriteFootY(
  ref: OfficeSpriteRef,
  tileRow: number,
): number {
  return tileRow * OFFICE_TILE - (SPRITE_SIZES[ref.name].height - OFFICE_TILE);
}

/** One entry per authored map, for the test that guards the art's shape. */
export interface OfficeSpriteMapEntry {
  readonly name: OfficeSpriteName;
  readonly label: string;
  readonly map: SpriteMap;
}

export function officeSpriteMaps(): ReadonlyArray<OfficeSpriteMapEntry> {
  const characterParts = [
    ...OFFICE_HEAD_MAPS,
    ...OFFICE_TORSO_MAPS,
    ...OFFICE_SEATED_MAPS,
    ...OFFICE_HAIR_MAPS,
    ...OFFICE_ACCESSORY_MAPS,
  ].map((part) => ({
    name: "character" as const,
    label: part.label,
    map: part.map,
  }));
  const props = PROP_SPRITE_NAMES.map((name) => ({
    name,
    label: name,
    map: PROP_MAPS[name],
  }));
  return [...characterParts, ...props];
}

// ---- Color math ------------------------------------------------------ //

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function parseHexColor(value: string): Rgba {
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (hex.length === 3) {
    const r = hex.slice(0, 1);
    const g = hex.slice(1, 2);
    const b = hex.slice(2, 3);
    return parseHexColor(`${r}${r}${g}${g}${b}${b}`);
  }
  if (hex.length !== 6 && hex.length !== 8) {
    return TRANSPARENT;
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
  if (
    Number.isNaN(r) ||
    Number.isNaN(g) ||
    Number.isNaN(b) ||
    Number.isNaN(a)
  ) {
    return TRANSPARENT;
  }
  return { r, g, b, a };
}

function toHex(channel: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  return clamped.toString(16).padStart(2, "0");
}

/**
 * The shade of a color, used for every `s` / `h` / `t` pixel. Derived rather
 * than picked so a new shirt color never needs a matching shadow entry.
 */
function shade(value: string, amount: number): string {
  const rgba = parseHexColor(value);
  const factor = 1 - amount;
  return `#${toHex(rgba.r * factor)}${toHex(rgba.g * factor)}${toHex(rgba.b * factor)}`;
}

/**
 * The full letter-to-color map for one draw. Unknown letters are simply absent,
 * which rasterizes as transparent: a typo in the art must fail the art test,
 * not throw inside an animation frame.
 */
export function officeSpriteColors(
  ref: OfficeSpriteRef,
  theme: OfficeTheme,
): ReadonlyMap<string, string> {
  const palette = officePalette(theme);
  const colors = new Map<string, string>();
  for (const [letter, key] of PALETTE_LETTERS) {
    colors.set(letter, palette[key]);
  }
  colors.set("Z", ref.tint ?? palette.tintDefault);
  const appearance = ref.appearance;
  if (appearance !== undefined) {
    colors.set("S", appearance.skin);
    colors.set("s", shade(appearance.skin, 0.22));
    colors.set("H", appearance.hair);
    colors.set("h", shade(appearance.hair, 0.28));
    colors.set("T", appearance.shirt);
    colors.set("t", shade(appearance.shirt, 0.24));
    colors.set("P", appearance.pants);
    colors.set("E", EYE_COLOR);
  }
  return colors;
}

// ---- Rasterization --------------------------------------------------- //

export function rasterizeSpriteMap(
  map: SpriteMap,
  colors: ReadonlyMap<string, string>,
  mirror: boolean,
): RasterizedSprite {
  const height = map.length;
  const width = height === 0 ? 0 : map[0].length;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const resolved = new Map<string, Rgba>();
  for (let y = 0; y < height; y += 1) {
    const row = map[y];
    for (let x = 0; x < width; x += 1) {
      const letter = row[mirror ? width - 1 - x : x];
      if (letter === ".") {
        continue;
      }
      let color = resolved.get(letter);
      if (color === undefined) {
        const hex = colors.get(letter);
        color = hex === undefined ? TRANSPARENT : parseHexColor(hex);
        resolved.set(letter, color);
      }
      if (color.a === 0) {
        continue;
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
      pixels[offset + 3] = color.a;
    }
  }
  return { width, height, pixels };
}

// ---- Map selection --------------------------------------------------- //

/** Overlay's non-transparent pixels win; `dy` shifts the overlay downward. */
function overlayMap(
  base: SpriteMap,
  overlay: SpriteMap,
  dy: number,
): SpriteMap {
  const rows: Array<string> = [];
  for (let y = 0; y < base.length; y += 1) {
    const baseRow = base[y];
    const source = y - dy;
    const overlayRow =
      source >= 0 && source < overlay.length ? overlay[source] : "";
    let out = "";
    for (let x = 0; x < baseRow.length; x += 1) {
      const over = x < overlayRow.length ? overlayRow[x] : ".";
      out += over === "." ? baseRow[x] : over;
    }
    rows.push(out);
  }
  return rows;
}

interface SelectedMap {
  readonly map: SpriteMap;
  readonly mirror: boolean;
}

/**
 * `left` is never authored: it is `right` mirrored, which is both half the art
 * to keep consistent and the only way the two stay in sync when one is edited.
 */
/** Hair, then anything worn over it, at whatever offset this head sits at. */
function dressHead(
  body: SpriteMap,
  ref: OfficeSpriteRef,
  source: "down" | "up" | "right",
  headDy: number,
): SpriteMap {
  const appearance = ref.appearance;
  const hairStyle = appearance === undefined ? 0 : appearance.hairStyle;
  const haired = overlayMap(body, officeHairMap(source, hairStyle), headDy);
  const accessory = ref.accessory;
  if (accessory === undefined) return haired;
  return overlayMap(haired, officeAccessoryMap(accessory), headDy);
}

function selectCharacterMap(ref: OfficeSpriteRef): SelectedMap {
  const pose = ref.pose ?? "stand";
  if (isOfficeSeatedPose(pose)) {
    // A seated head sits a row lower than a standing one - further on a slump,
    // less on a lean - so the `up` hair and anything over it ride down with it
    // rather than floating above the scalp.
    return {
      map: dressHead(
        officeSeatedMap(pose, ref.facing === "down" ? "down" : "up"),
        ref,
        ref.facing === "down" ? "down" : "up",
        officeHeadOffsetOf(pose),
      ),
      mirror: false,
    };
  }
  const facing = ref.facing ?? "down";
  const source = facing === "left" ? "right" : facing;
  const body = overlayMap(
    officeHeadMap(source),
    officeTorsoMap(source, pose),
    0,
  );
  return {
    map: dressHead(body, ref, source, 0),
    mirror: facing === "left",
  };
}

/**
 * Whether this ref draws a prop flipped.
 *
 * ONE ANSWER, because two would drift - and did. `selectMap` decides what is
 * drawn and `officeSpriteCacheKey` decides what that drawing is filed under,
 * and a cache key that disagreed with the drawing about whether `facing`
 * mattered handed back the wrong surface without ever calling `selectMap`.
 *
 * A prop outside the set ignores `facing` however it is set, so a stray
 * `facing: "left"` on a desk can neither flip it nor give it a second entry.
 */
function isMirroredProp(ref: OfficeSpriteRef): boolean {
  return MIRRORED_PROP_NAMES.has(ref.name) && ref.facing === "left";
}

function selectMap(ref: OfficeSpriteRef): SelectedMap {
  if (ref.name === "character") {
    return selectCharacterMap(ref);
  }
  return {
    map: PROP_MAPS[ref.name],
    mirror: isMirroredProp(ref),
  };
}

/**
 * Whether this sprite PAINTS the pixel at this offset, or leaves what is behind
 * it showing through.
 *
 * A sprite's box is mostly sky for most of this art - a bench is 32 x 16 of box
 * over a seat with two legs, a bed 8 px shorter than the box a campus seat
 * declares - so "is this drawable what the reader sees here" cannot be answered
 * from a rect. The map is the art's own answer: `.` is the authored hole and
 * every other letter is a colour the palette resolves (the map guard asserts
 * that, so a letter is paint).
 *
 * Exported for the hit-ordering cases, which have to take their witness point
 * from a pixel somebody can actually see: a point in the transparent corner of a
 * box proves nothing about what a click there should name. The same composition
 * the renderer draws is used, poses, hair and mirroring included.
 */
export function officeSpriteOpaqueAt(
  ref: OfficeSpriteRef,
  x: number,
  y: number,
): boolean {
  const { map, mirror } = selectMap(ref);
  if (y < 0 || y >= map.length) return false;
  const row = map[y];
  if (x < 0 || x >= row.length) return false;
  return row[mirror ? row.length - 1 - x : x] !== ".";
}

// ---- Draw ------------------------------------------------------------ //

export type SpriteSurface = HTMLCanvasElement | OffscreenCanvas;

/** `null` records a surface that could not be created, so we try exactly once. */
const surfaceCache = new Map<string, SpriteSurface | null>();

/**
 * How many rasterized surfaces to keep.
 *
 * The cache is keyed partly by an agent's APPEARANCE, which is generated per
 * agent id - so without a cap it holds one entry per pose per agent the person
 * has ever opened an office on, in any epic, for as long as the tab lives.
 * A floor draws a few hundred distinct sprites at once, so this is roomy
 * enough that a live floor never evicts something it is still using, and
 * bounded enough that a long session cannot grow without limit.
 *
 * The densest view's working set at office zoom is about 850 surfaces in a
 * 1280 x 700 tile - one per distinct look of every visible seated agent, plus
 * the walkers - and the four new poses and the front-facing seated maps
 * multiply the KEYS over that. 1,024 was within thrashing distance of it:
 * evicting a sprite the same frame asks for again is the one failure mode a
 * cap can have. A seated surface is under 2 KB of pixels, so 4,096 of them
 * stay under 32 MB worst case, shared by every canvas in the tab, once.
 */
export const OFFICE_SPRITE_CACHE_LIMIT = 4096;

export function clearOfficeSpriteCache(): void {
  surfaceCache.clear();
}

/** How many surfaces are held. Exists so the cap can be asserted on. */
export function officeSpriteCacheSize(): number {
  return surfaceCache.size;
}

/**
 * Reads a cached surface, refreshing its recency.
 *
 * `undefined` means "not cached"; `null` means "cached as unbuildable". A `Map`
 * iterates in INSERTION order, so deleting and re-inserting a hit is what moves
 * it to the young end and makes the eviction below least-recently-used rather
 * than first-in-first-out - the difference between evicting the sprite nobody
 * has asked for in ten minutes and evicting the floor tile every frame draws.
 */
function readCachedSurface(key: string): SpriteSurface | null | undefined {
  if (!surfaceCache.has(key)) return undefined;
  const surface = surfaceCache.get(key) ?? null;
  surfaceCache.delete(key);
  surfaceCache.set(key, surface);
  return surface;
}

function writeCachedSurface(key: string, surface: SpriteSurface | null): void {
  surfaceCache.set(key, surface);
  while (surfaceCache.size > OFFICE_SPRITE_CACHE_LIMIT) {
    const oldest = surfaceCache.keys().next();
    if (oldest.done === true) return;
    surfaceCache.delete(oldest.value);
  }
}

/**
 * The cached surface for one sprite, rasterizing it on the first ask. `null`
 * where the host has no 2D context to paint on.
 */
export function officeSpriteSurface(
  ref: OfficeSpriteRef,
  theme: OfficeTheme,
): SpriteSurface | null {
  const key = officeSpriteCacheKey(ref, theme);
  const cached = readCachedSurface(key);
  if (cached !== undefined) return cached;
  const built = buildSurface(ref, theme);
  writeCachedSurface(key, built);
  return built;
}

/**
 * What makes two sprite requests the SAME surface: the name, the palette, and
 * for a character every part of the look that is drawn into its pixels.
 *
 * Exported because "how many distinct sprites does one frame ask for" is a
 * budget, and the only honest answer to it is the key the cache itself uses.
 */
export function officeSpriteCacheKey(
  ref: OfficeSpriteRef,
  theme: OfficeTheme,
): string {
  if (ref.name !== "character") {
    // THE KEY VARIES EXACTLY WHERE THE PIXELS DO. `facing` became a
    // pixel-varying input for the mirrored names when `selectMap` started
    // honouring it, and a key that ignored it meant the first facing drawn
    // won for that name across every canvas: a van drawn facing right, then
    // the same name and theme facing left, got the cached right-facing
    // surface back without `selectMap` being consulted at all.
    //
    // What is appended is the MIRROR DECISION rather than the raw facing,
    // which is the same thing `selectMap` computes. Every other prop's key is
    // therefore byte-identical to what it was - a pin says so - and a facing
    // that does not mirror (a desk's, or a van's `right`) adds no entry.
    const mirrored = isMirroredProp(ref);
    return `${ref.name}|${theme}|${ref.tint ?? ""}${mirrored ? "|left" : ""}`;
  }
  const appearance = ref.appearance;
  const look =
    appearance === undefined
      ? "-"
      : `${appearance.skin}${appearance.hair}${appearance.hairStyle}${appearance.shirt}${appearance.pants}`;
  return `character|${theme}|${ref.facing ?? "down"}|${ref.pose ?? "stand"}|${ref.accessory ?? ""}|${look}`;
}

/**
 * Paints a raster onto a fresh offscreen surface, or reports that this host has
 * no 2D context to paint on. jsdom and any canvas-less host take the `null`
 * path: drawing is decoration, and refusing to render must never take the
 * caller down with it.
 */
function paintSurface(raster: RasterizedSprite): SpriteSurface | null {
  const { width, height, pixels } = raster;
  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(width, height);
    const context = offscreen.getContext("2d");
    if (context === null) {
      return null;
    }
    const image = context.createImageData(width, height);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    return offscreen;
  }
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    return null;
  }
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas;
}

function buildSurface(
  ref: OfficeSpriteRef,
  theme: OfficeTheme,
): SpriteSurface | null {
  const selected = selectMap(ref);
  const raster = rasterizeSpriteMap(
    selected.map,
    officeSpriteColors(ref, theme),
    selected.mirror,
  );
  if (raster.width === 0 || raster.height === 0) {
    return null;
  }
  return paintSurface(raster);
}

/**
 * Draws one sprite with its TOP-LEFT at the sprite-space point `at`. Anchoring
 * anywhere else is the caller's arithmetic: the layers of a frame anchor
 * differently and only the caller knows which layer it is drawing.
 *
 * The caller's transform is the camera and is left exactly as found.
 */
export function drawOfficeSprite(
  ctx: CanvasRenderingContext2D,
  ref: OfficeSpriteRef,
  at: OfficePoint,
  theme: OfficeTheme,
): void {
  const surface = officeSpriteSurface(ref, theme);
  if (surface === null) {
    return;
  }
  ctx.drawImage(surface, at.x, at.y);
}
