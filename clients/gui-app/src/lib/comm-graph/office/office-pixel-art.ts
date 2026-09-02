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
import type {
  OfficePoint,
  OfficeSize,
  OfficeSpriteName,
  OfficeSpriteRef,
  OfficeTheme,
} from "@/lib/comm-graph/office/office-types";
import {
  BUBBLE_ATTENTION_MAP,
  BUBBLE_AWAITING_MAP,
  BUBBLE_HELLO_MAP,
  BUBBLE_NOTICE_MAP,
  BUBBLE_SLEEP_MAP,
  CHAIR_MAP,
  COFFEE_MACHINE_MAP,
  DESK_MAP,
  DOOR_MAP,
  ENVELOPE_MAP,
  FLOOR_A_MAP,
  FLOOR_B_MAP,
  MONITOR_OFF_MAP,
  MONITOR_ON_B_MAP,
  MONITOR_ON_MAP,
  NAMEPLATE_MAP,
  PARTITION_MAP,
  PLANT_MAP,
  RUG_MAP,
  SIGN_MAP,
  SPARKLE_MAP,
  WALL_MAP,
  WALL_TOP_MAP,
  WHITEBOARD_MAP,
  WINDOW_MAP,
} from "@/lib/comm-graph/office/office-prop-maps";
import {
  officeHairMap,
  officeHeadMap,
  officeSeatedMap,
  officeTorsoMap,
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
  desk: { width: 32, height: 16 },
  "monitor-on": { width: 16, height: 12 },
  "monitor-on-b": { width: 16, height: 12 },
  "monitor-off": { width: 16, height: 12 },
  nameplate: { width: 12, height: 6 },
  partition: { width: 16, height: 16 },
  sign: { width: 32, height: 16 },
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
};

const PROP_MAPS: Readonly<Record<OfficeSpriteName, SpriteMap>> = {
  character: [],
  desk: DESK_MAP,
  "monitor-on": MONITOR_ON_MAP,
  "monitor-on-b": MONITOR_ON_B_MAP,
  "monitor-off": MONITOR_OFF_MAP,
  nameplate: NAMEPLATE_MAP,
  partition: PARTITION_MAP,
  sign: SIGN_MAP,
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
};

/** Every name that has a single authored map, i.e. everything but `character`. */
const PROP_SPRITE_NAMES: ReadonlyArray<OfficeSpriteName> = [
  "desk",
  "monitor-on",
  "monitor-on-b",
  "monitor-off",
  "nameplate",
  "partition",
  "sign",
  "chair",
  "plant",
  "floor-a",
  "floor-b",
  "rug",
  "wall",
  "wall-top",
  "door",
  "window",
  "whiteboard",
  "coffee-machine",
  "envelope",
  "bubble-awaiting",
  "bubble-attention",
  "bubble-notice",
  "bubble-hello",
  "bubble-sleep",
  "sparkle",
];

export function officeSpriteSize(ref: OfficeSpriteRef): OfficeSize {
  return SPRITE_SIZES[ref.name];
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
function selectCharacterMap(ref: OfficeSpriteRef): SelectedMap {
  const appearance = ref.appearance;
  const hairStyle = appearance === undefined ? 0 : appearance.hairStyle;
  const pose = ref.pose ?? "stand";
  if (pose === "sit" || pose === "type1" || pose === "type2") {
    // A seated head sits one row lower than a standing one, so the `up` hair
    // rides down with it rather than floating above the scalp.
    return {
      map: overlayMap(officeSeatedMap(pose), officeHairMap("up", hairStyle), 1),
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
    map: overlayMap(body, officeHairMap(source, hairStyle), 0),
    mirror: facing === "left",
  };
}

function selectMap(ref: OfficeSpriteRef): SelectedMap {
  if (ref.name === "character") {
    return selectCharacterMap(ref);
  }
  return { map: PROP_MAPS[ref.name], mirror: false };
}

// ---- Draw ------------------------------------------------------------ //

type SpriteSurface = HTMLCanvasElement | OffscreenCanvas;

/** `null` records a surface that could not be created, so we try exactly once. */
const surfaceCache = new Map<string, SpriteSurface | null>();

export function clearOfficeSpriteCache(): void {
  surfaceCache.clear();
}

function cacheKey(ref: OfficeSpriteRef, theme: OfficeTheme): string {
  if (ref.name !== "character") {
    return `${ref.name}|${theme}|${ref.tint ?? ""}`;
  }
  const appearance = ref.appearance;
  const look =
    appearance === undefined
      ? "-"
      : `${appearance.skin}${appearance.hair}${appearance.hairStyle}${appearance.shirt}${appearance.pants}`;
  return `character|${theme}|${ref.facing ?? "down"}|${ref.pose ?? "stand"}|${look}`;
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
  const key = cacheKey(ref, theme);
  let surface = surfaceCache.get(key);
  if (surface === undefined) {
    surface = buildSurface(ref, theme);
    surfaceCache.set(key, surface);
  }
  if (surface === null) {
    return;
  }
  ctx.drawImage(surface, at.x, at.y);
}
