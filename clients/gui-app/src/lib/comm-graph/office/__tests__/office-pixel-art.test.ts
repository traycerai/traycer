import { afterEach, describe, expect, it } from "vitest";
import {
  clearOfficeSpriteCache,
  drawOfficeSprite,
  officePalette,
  officeSpriteColors,
  officeSpriteMaps,
  officeSpriteCacheSize,
  officeSpriteSize,
  officeSpriteSurface,
  rasterizeSpriteMap,
  OFFICE_SPRITE_CACHE_LIMIT,
  OFFICE_SPRITE_LETTERS,
  type RasterizedSprite,
} from "@/lib/comm-graph/office/office-pixel-art";
import { OFFICE_ACCESSORY_MAPS_BY_NAME } from "@/lib/comm-graph/office/office-sprite-maps";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeAppearance,
  OfficeSpriteName,
  OfficeSpriteRef,
} from "@/lib/comm-graph/office/office-types";

/**
 * Every sprite the union names. Written as a record rather than an array so the
 * compiler rejects a name added to `OfficeSpriteName` and forgotten here - which
 * is the failure this file exists to catch, since the map registry is a
 * hand-maintained list and an unregistered map is simply never asserted on.
 */
const ALL_SPRITE_NAMES: Readonly<Record<OfficeSpriteName, true>> = {
  character: true,
  face: true,
  slab: true,
  "desk-front": true,
  lamp: true,
  "stairs-side": true,
  cubby: true,
  silhouette: true,
  skybridge: true,
  board: true,
  "roof-edge": true,

  desk: true,
  "monitor-on": true,
  "monitor-on-b": true,
  "monitor-off": true,
  nameplate: true,
  partition: true,
  sign: true,
  "monitor-small-on": true,
  "monitor-small-off": true,
  "monitor-wide-on": true,
  "monitor-wide-on-b": true,
  "monitor-wide-off": true,
  "monitor-crash": true,
  "envelope-stack-1": true,
  "envelope-stack-2": true,
  "envelope-stack-3": true,
  clock: true,
  "dust-sheet": true,
  box: true,
  reception: true,
  stairs: true,
  "water-cooler": true,
  "cafe-table": true,
  sofa: true,
  bin: true,
  "paper-ball": true,
  "watering-can": true,
  "pingpong-table": true,
  arcade: true,
  "floor-pod-a": true,
  "floor-pod-b": true,
  "partition-h": true,
  "pod-plate": true,
  "sleep-bag": true,
  armchair: true,
  bookcase: true,
  "floor-grass-a": true,
  "floor-grass-b": true,
  tree: true,
  bench: true,
  foosball: true,
  dartboard: true,
  "chess-table": true,
  tv: true,
  treadmill: true,
  "floor-pod-warm-a": true,
  "floor-pod-warm-b": true,
  planter: true,
  shelf: true,
  "shelf-h": true,
  vending: true,
  "menu-board": true,
  chair: true,
  plant: true,
  "floor-a": true,
  "floor-b": true,
  rug: true,
  wall: true,
  "wall-top": true,
  door: true,
  window: true,
  whiteboard: true,
  "coffee-machine": true,
  envelope: true,
  "bubble-awaiting": true,
  "bubble-attention": true,
  "bubble-notice": true,
  "bubble-hello": true,
  "bubble-sleep": true,
  sparkle: true,
  "tier-step": true,
  podium: true,
  console: true,
  "floor-iso-a": true,
  "floor-iso-b": true,
  "floor-grass-iso-a": true,
  "floor-grass-iso-b": true,
  "wall-iso-left": true,
  "wall-iso-right": true,
  "door-iso": true,
  "desk-iso": true,
  "block-left": true,
  "block-right": true,
  "block-top": true,
  "window-lit": true,
  "window-dark": true,
  spire: true,

  bed: true,
  "bed-occupied": true,
  "lounge-chair": true,
  "low-table": true,
  "records-door": true,
  "cross-sign": true,

  // ---- K2: the five other views' civic art -------------------------- //
  "glass-partition": true,
  "siren-light": true,
  "siren-light-b": true,
  "bed-iso": true,
  "lounge-chair-iso": true,
  "hospital-roof-cross": true,
  "bus-shelter": true,
  "warehouse-door-iso": true,
  "medbay-bed": true,
  "gallery-seat": true,

  // ---- K3: the three civic vehicles --------------------------------- //
  ambulance: true,
  "ambulance-b": true,
  "ambulance-iso": true,
  "ambulance-iso-b": true,
  "police-car": true,
  "police-car-b": true,
  "police-car-iso": true,
  "police-car-iso-b": true,
  "fire-engine": true,
  "fire-engine-b": true,
  "fire-engine-iso": true,
  "fire-engine-iso-b": true,
};

function mapNamed(name: OfficeSpriteName): ReadonlyArray<string> {
  const entry = officeSpriteMaps().find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`no authored map for ${name}`);
  }
  return entry.map;
}

const APPEARANCE: OfficeAppearance = {
  skin: "#e8b894",
  hair: "#4a3223",
  hairStyle: 1,
  shirt: "#3b6fd6",
  pants: "#3a4055",
  accent: "#d97757",
};

function pixelAt(
  sprite: RasterizedSprite,
  x: number,
  y: number,
): ReadonlyArray<number> {
  const offset = (y * sprite.width + x) * 4;
  return [
    sprite.pixels[offset],
    sprite.pixels[offset + 1],
    sprite.pixels[offset + 2],
    sprite.pixels[offset + 3],
  ];
}

/** Rasterizes through the public cache path so `facing` selection is covered. */
function surfaceRaster(
  ref: OfficeSpriteRef,
  theme: "light" | "dark",
): RasterizedSprite {
  clearOfficeSpriteCache();
  let dimensions: { width: number; height: number } | null = null;
  // A HOLDER, not a bare `let`: the write below happens inside a mocked
  // callback, which control-flow analysis cannot see, so a plain local would
  // still be typed `null` at the check and the comparison would be between
  // two literals.
  const captured: { value: RasterizedSprite | null } = { value: null };
  const restore = stubGetContext(() => ({
    createImageData: (width: number, height: number) => {
      dimensions = { width, height };
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData: (image: { readonly data: Uint8ClampedArray }) => {
      if (dimensions === null) throw new Error("missing raster dimensions");
      captured.value = {
        width: dimensions.width,
        height: dimensions.height,
        pixels: image.data,
      };
    },
  }));
  try {
    officeSpriteSurface(ref, theme);
  } finally {
    restore();
  }
  const raster = captured.value;
  if (raster === null) throw new Error("sprite did not rasterize");
  return raster;
}

function rasterFromImageData(
  captured: RasterizedSprite[],
  dimensions: { value: { width: number; height: number } | null },
  image: { readonly data: Uint8ClampedArray },
): void {
  const size = dimensions.value;
  if (size === null) throw new Error("missing raster dimensions");
  captured.push({
    width: size.width,
    height: size.height,
    pixels: image.data,
  });
}

function warmDrawPair(
  name: OfficeSpriteName,
  firstFacing: "left" | "right",
): Readonly<{
  readonly drawn: ReadonlyArray<unknown>;
  readonly rasters: ReadonlyArray<RasterizedSprite>;
}> {
  clearOfficeSpriteCache();
  const drawn: unknown[] = [];
  const rasters: RasterizedSprite[] = [];
  const dimensions: { value: { width: number; height: number } | null } = {
    value: null,
  };
  const restore = stubGetContext(() => ({
    drawImage: (surface: unknown) => drawn.push(surface),
    createImageData: (width: number, height: number) => {
      dimensions.value = { width, height };
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData: (image: { readonly data: Uint8ClampedArray }) =>
      rasterFromImageData(rasters, dimensions, image),
  }));
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx === null) throw new Error("missing drawing context");
    drawOfficeSprite(
      ctx,
      { name, facing: firstFacing },
      { x: 0, y: 0 },
      "light",
    );
    drawOfficeSprite(
      ctx,
      { name, facing: firstFacing === "left" ? "right" : "left" },
      { x: 0, y: 0 },
      "light",
    );
  } finally {
    restore();
  }
  return { drawn, rasters };
}

const VEHICLE_SPRITE_NAMES: ReadonlyArray<OfficeSpriteName> = [
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
];

afterEach(() => {
  clearOfficeSpriteCache();
});

describe("sprite maps", () => {
  it("author a map for every sprite name but `character`", () => {
    // `character` is composed from head / torso / hair parts instead of one
    // map, so it is the only name without an entry of its own.
    const authored = new Set<string>(
      officeSpriteMaps().map((entry) => entry.name),
    );
    const missing = Object.keys(ALL_SPRITE_NAMES).filter(
      (name) => name !== "character" && !authored.has(name),
    );
    expect(missing).toEqual([]);
  });

  /**
   * CR3: `OFFICE_ACCESSORY_MAPS` (the array `officeSpriteMaps()` enumerates)
   * and the accessory lookup used to be two hand-written copies of the same
   * roster - add an accessory to one and forget the other, and nothing here
   * caught it, since the completeness test above only walks what it's handed.
   *
   * The stronger half of the fix is the type, not this case:
   * `OFFICE_ACCESSORY_MAPS_BY_NAME` is keyed on `OfficeCharacterAccessory`, the
   * same union the scene already uses for an accessory, so a member added to
   * that union and forgotten here is a COMPILE ERROR, not a missing sprite -
   * confirmed directly by adding `"lanyard"` to the union, which fails with
   * `error TS2741: Property 'lanyard' is missing in type '{ headphones:
   * SpriteMap; }'`. This case guards the OTHER direction: that the enumerated
   * array stays DERIVED from the record rather than drifting back into a
   * second hand-written copy.
   *
   * Reference equality against the record's own values - not a label-string
   * match - is the point: a label-based assertion would still pass if someone
   * enumerated a DIFFERENT map under the right label, which is exactly the
   * drift being guarded against.
   */
  it("enumerates the exact map object the accessory lookup names for every accessory", () => {
    for (const [name, map] of Object.entries(OFFICE_ACCESSORY_MAPS_BY_NAME)) {
      const enumerated = officeSpriteMaps().some((entry) => entry.map === map);
      expect(enumerated, name).toBe(true);
    }
  });

  it("are rectangular and match the size declared for their sprite", () => {
    for (const entry of officeSpriteMaps()) {
      const size = officeSpriteSize({ name: entry.name });
      expect(
        { label: entry.label, height: entry.map.length },
        entry.label,
      ).toEqual({ label: entry.label, height: size.height });
      const widths = new Set(entry.map.map((row) => row.length));
      expect({ label: entry.label, widths: [...widths] }, entry.label).toEqual({
        label: entry.label,
        widths: [size.width],
      });
    }
  });

  it("only use letters the palette or an appearance can resolve", () => {
    // This is the typo net for the art: a stray letter renders as a hole that
    // nobody notices at 1x, and every map is data no type can check.
    for (const entry of officeSpriteMaps()) {
      for (const [index, row] of entry.map.entries()) {
        for (const letter of row) {
          expect(
            letter === "." || OFFICE_SPRITE_LETTERS.has(letter),
            `${entry.label} row ${index} letter ${letter}`,
          ).toBe(true);
        }
      }
    }
  });

  it("resolves every letter for a character sprite in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const colors = officeSpriteColors(
        { name: "character", appearance: APPEARANCE, tint: "#ffffff" },
        theme,
      );
      for (const letter of OFFICE_SPRITE_LETTERS) {
        expect(colors.get(letter), `${theme}/${letter}`).toBeDefined();
      }
    }
  });

  // The scene swaps a monitor's two lit frames while an agent works. Differing
  // screen rows are what reads as scrolling code; a differing BEZEL would read
  // as the whole monitor twitching, which is why the chassis rows are pinned.
  // One contract, so one test - the wide monitor obeys it for the same reason
  // the standard one does.
  it.each([
    ["monitor-on", "monitor-on-b"],
    ["monitor-wide-on", "monitor-wide-on-b"],
  ] as const)(
    "alternates %s and %s without moving the chassis",
    (nameA, nameB) => {
      const frameA = mapNamed(nameA);
      const frameB = mapNamed(nameB);
      const chassisRows = [0, 1, 9, 10, 11];
      for (const row of chassisRows) {
        expect(frameB[row], `row ${row}`).toEqual(frameA[row]);
      }
      const screenRows = [2, 3, 4, 5, 6, 7, 8];
      expect(screenRows.map((row) => frameB[row]).join("")).not.toEqual(
        screenRows.map((row) => frameA[row]).join(""),
      );
    },
  );

  /** Where the two lamps sit on the bar, per projection. */
  const LAMPS_OBLIQUE = { ax: 10, ay: 1, bx: 12, by: 1 } as const;
  const LAMPS_ISO = { ax: 18, ay: 2, bx: 20, by: 2 } as const;

  // ONE OBJECT PER CASE rather than a six-wide tuple: the two lamp positions
  // are a pair of points, and spelling them out positionally both trips the
  // parameter limit and makes the call site unreadable at a glance.
  it.each([
    { nameA: "ambulance", nameB: "ambulance-b", lamp: LAMPS_OBLIQUE },
    { nameA: "police-car", nameB: "police-car-b", lamp: LAMPS_OBLIQUE },
    { nameA: "fire-engine", nameB: "fire-engine-b", lamp: LAMPS_OBLIQUE },
    { nameA: "ambulance-iso", nameB: "ambulance-iso-b", lamp: LAMPS_ISO },
    { nameA: "police-car-iso", nameB: "police-car-iso-b", lamp: LAMPS_ISO },
    { nameA: "fire-engine-iso", nameB: "fire-engine-iso-b", lamp: LAMPS_ISO },
  ] as const)(
    "swaps the two siren lamps between $nameA and $nameB",
    ({ nameA, nameB, lamp }) => {
      const { ax: lampAX, ay: lampAY, bx: lampBX, by: lampBY } = lamp;
      const frameA = rasterizeSpriteMap(
        mapNamed(nameA),
        officeSpriteColors({ name: nameA }, "light"),
        false,
      );
      const frameB = rasterizeSpriteMap(
        mapNamed(nameB),
        officeSpriteColors({ name: nameB }, "light"),
        false,
      );

      expect(pixelAt(frameA, lampAX, lampAY)).toEqual(
        pixelAt(frameB, lampBX, lampBY),
      );
      expect(pixelAt(frameA, lampBX, lampBY)).toEqual(
        pixelAt(frameB, lampAX, lampAY),
      );
      expect(pixelAt(frameA, lampAX, lampAY)).not.toEqual(
        pixelAt(frameA, lampBX, lampBY),
      );
    },
  );

  it("guard: leaves an ordinary prop with facing left unmirrored", () => {
    // Guard case: this is green before vehicle facing support. It protects the
    // named vehicle exception from turning into a rule that mirrors every prop.
    const left = surfaceRaster({ name: "desk", facing: "left" }, "light");
    const expected = rasterizeSpriteMap(
      mapNamed("desk"),
      officeSpriteColors({ name: "desk" }, "light"),
      false,
    );
    expect(left.pixels).toEqual(expected.pixels);
  });

  it("mirrors a vehicle with facing left relative to facing right", () => {
    const right = surfaceRaster(
      { name: "ambulance", facing: "right" },
      "light",
    );
    const left = surfaceRaster({ name: "ambulance", facing: "left" }, "light");

    for (let y = 0; y < right.height; y += 1) {
      for (let x = 0; x < right.width; x += 1) {
        expect(pixelAt(left, x, y), `pixel ${x},${y}`).toEqual(
          pixelAt(right, right.width - 1 - x, y),
        );
      }
    }
  });

  it.each(VEHICLE_SPRITE_NAMES)(
    "keeps both warm-cache facing orders distinct and correct for %s",
    (name) => {
      for (const firstFacing of ["right", "left"] as const) {
        const pair = warmDrawPair(name, firstFacing);
        expect(
          pair.rasters,
          `${name}/${firstFacing} raster count`,
        ).toHaveLength(2);
        expect(pair.drawn, `${name}/${firstFacing} draw count`).toHaveLength(2);
        expect(pair.drawn[0], `${name}/${firstFacing} cache identity`).not.toBe(
          pair.drawn[1],
        );
        const secondFacing = firstFacing === "left" ? "right" : "left";
        expect(pair.rasters[0].pixels).toEqual(
          rasterizeSpriteMap(
            mapNamed(name),
            officeSpriteColors({ name, facing: firstFacing }, "light"),
            firstFacing === "left",
          ).pixels,
        );
        expect(pair.rasters[1].pixels).toEqual(
          rasterizeSpriteMap(
            mapNamed(name),
            officeSpriteColors({ name, facing: secondFacing }, "light"),
            secondFacing === "left",
          ).pixels,
        );
      }
    },
  );

  it("GUARD: keeps a desk's stray left facing out of its cache key", () => {
    clearOfficeSpriteCache();
    const drawn: RasterizedSprite[] = [];
    const dimensions: { value: { width: number; height: number } | null } = {
      value: null,
    };
    const restore = stubGetContext(() => ({
      createImageData: (width: number, height: number) => {
        dimensions.value = { width, height };
        return { data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData: (image: { readonly data: Uint8ClampedArray }) =>
        rasterFromImageData(drawn, dimensions, image),
    }));
    try {
      const first = officeSpriteSurface({ name: "desk" }, "light");
      const sizeBeforeStrayFacing = officeSpriteCacheSize();
      const left = officeSpriteSurface(
        { name: "desk", facing: "left" },
        "light",
      );
      expect(left).toBe(first);
      expect(officeSpriteCacheSize()).toBe(sizeBeforeStrayFacing);
    } finally {
      restore();
    }
    expect(drawn).toHaveLength(1);
    expect(drawn[0].pixels).toEqual(
      rasterizeSpriteMap(
        mapNamed("desk"),
        officeSpriteColors({ name: "desk" }, "light"),
        false,
      ).pixels,
    );
  });

  it("declares the sizes the scene positions the new fixtures by", () => {
    // The rectangularity test above only proves a map AGREES with its declared
    // size; both can be wrong together. These are the numbers the scene's
    // offsets are computed against, so they are pinned independently.
    const expected: ReadonlyArray<readonly [OfficeSpriteName, number, number]> =
      [
        ["monitor-small-on", 12, 9],
        ["monitor-small-off", 12, 9],
        ["monitor-wide-on", 24, 12],
        ["monitor-wide-on-b", 24, 12],
        ["monitor-wide-off", 24, 12],
        ["monitor-crash", 16, 12],
        ["envelope-stack-1", 10, 6],
        ["envelope-stack-2", 10, 8],
        ["envelope-stack-3", 10, 10],
        ["clock", 12, 12],
        ["dust-sheet", 32, 16],
        ["box", 16, 16],
        ["reception", 32, 16],
        ["stairs", 32, 32],
        ["water-cooler", 16, 24],
        ["cafe-table", 32, 16],
        ["vending", 16, 24],
        ["menu-board", 32, 16],
      ];
    for (const [name, width, height] of expected) {
      expect(officeSpriteSize({ name }), name).toEqual({ width, height });
    }
  });

  /**
   * THE MEDBAY LIGHT IS A PAIR, and a pair whose frames are the same picture is
   * a light that does not blink.
   *
   * Same size, because the sign draws both at one anchor, and DIFFERENT
   * content, because the whole of the thing is the alternation. Read off the
   * authored maps rather than the rasterized pixels: a frame that differed only
   * in a letter both themes resolve to the same colour would pass a pixel
   * comparison in one theme and fail in the other.
   */
  it("gives the medbay light two frames of one size that are not the same picture", () => {
    const byName = new Map(
      officeSpriteMaps().map((entry) => [entry.name, entry.map]),
    );
    const frameA = byName.get("siren-light");
    const frameB = byName.get("siren-light-b");
    expect(frameA).toBeDefined();
    expect(frameB).toBeDefined();
    if (frameA === undefined || frameB === undefined) return;
    expect(officeSpriteSize({ name: "siren-light-b" })).toEqual(
      officeSpriteSize({ name: "siren-light" }),
    );
    expect(frameA.join("\n")).not.toBe(frameB.join("\n"));
    // FRAME 0 DARK, FRAME 1 LIT, IN THAT ORDER, because the sign that drives
    // them reads the order as a contract: it holds frame 0 while the ward is
    // empty, alternates while a bed is taken, and holds FRAME 1 under reduced
    // motion so a steady beacon still says occupied. Two lit frames - which is
    // what a rotating beacon would want - make "empty" and "occupied, reduced
    // motion" the same picture, so this asserts the distinction rather than the
    // prettier animation. Swap the maps and this fails.
    expect(frameA.join("")).not.toContain("y");
    expect(frameA.join("")).not.toContain("n");
    expect(frameB.join("")).toContain("y");
    // AND ONLY THE LENS DIFFERS. One silhouette, housing and base included, so
    // the alternation reads as a lamp blinking rather than a fixture changing
    // shape - masking the three lens letters must leave the two frames equal.
    const silhouette = (map: ReadonlyArray<string>): string =>
      map.join("\n").replace(/[dyn]/g, "*");
    expect(silhouette(frameA)).toBe(silhouette(frameB));
  });

  /**
   * The isometric civic art is drawn at an anchor its PARTNER's size decides,
   * so a size that disagrees is art drawn somewhere the tile is not.
   *
   * - `bed-iso` is drawn where `desk-iso` is drawn (a seat's own tile corner,
   *   bottom-centre on the diamond);
   * - `hospital-roof-cross` is laid ON `block-top`, at the same origin, so it
   *   has to be the same diamond;
   * - `warehouse-door-iso` stands free on its tile exactly as `door-iso` does;
   * - `medbay-bed` replaces a console's two tiles on the amphitheatre floor.
   *
   * Pinned as EQUALITY against the partner rather than as literal numbers: the
   * requirement is that the two agree, and a pair of literals can drift apart
   * while both stay "right".
   */
  it("sizes every civic piece as the anchor it is drawn against", () => {
    const pairs: ReadonlyArray<readonly [OfficeSpriteName, OfficeSpriteName]> =
      [
        ["bed-iso", "desk-iso"],
        ["hospital-roof-cross", "block-top"],
        ["bus-shelter", "desk-iso"],
        ["warehouse-door-iso", "door-iso"],
        ["medbay-bed", "console"],
      ];
    for (const [piece, anchor] of pairs) {
      expect(officeSpriteSize({ name: piece }), piece).toEqual(
        officeSpriteSize({ name: anchor }),
      );
    }
    // The two one-tile seats are a tile, which is what lets a sitter's own
    // sprite cover them.
    for (const name of ["lounge-chair-iso", "gallery-seat"] as const) {
      expect(officeSpriteSize({ name }), name).toEqual({
        width: OFFICE_TILE,
        height: OFFICE_TILE,
      });
    }
  });

  it("stands the cafeteria's two floor fixtures a full tile above their tile", () => {
    // The scene lifts a prop by its overhang so its FOOT lands on its tile. The
    // cooler and the vending machine are the two cafeteria fixtures that stand
    // on the floor rather than hanging on a wall, so both are authored at the
    // coffee machine's height - a shorter one would float.
    for (const name of ["water-cooler", "vending"] as const) {
      expect(officeSpriteSize({ name }), name).toEqual(
        officeSpriteSize({ name: "coffee-machine" }),
      );
    }
  });

  it("gives the cafeteria table a cup at each of its two seats", () => {
    // Two cups is what says "two people sat here" at 1x; the scene emits exactly
    // two `cafe` seat spots per table, so one cup would contradict the sim.
    const table = mapNamed("cafe-table");
    const cupRow = table[5];
    const cups = cupRow.split("O").filter((run) => run === "bb");
    expect(cups).toHaveLength(2);
  });

  it("writes the menu board's own content rather than leaving a field for a label", () => {
    // Unlike the cabin sign, nothing is drawn over this board: there is no
    // cafeteria name. A flat field would render as a blank slab on the wall.
    const board = mapNamed("menu-board").join("");
    expect(board).toContain("b");
    expect(board).toContain("B");
  });

  it("covers the whole desk with the dust sheet", () => {
    // The scene draws the sheet at the desk's TOP-LEFT and expects the desk to
    // stop being readable. A sheet smaller than the desk, or one with a hole in
    // it, would leave the archived desk showing through.
    expect(officeSpriteSize({ name: "dust-sheet" })).toEqual(
      officeSpriteSize({ name: "desk" }),
    );
    expect(mapNamed("dust-sheet").join("")).not.toContain(".");
  });

  it("grows the envelope stack strictly upward", () => {
    // The scene swaps between the three bottom-anchored, so a stack that did
    // not get taller would read as the pile never changing.
    const heights = (
      ["envelope-stack-1", "envelope-stack-2", "envelope-stack-3"] as const
    ).map((name) => mapNamed(name).length);
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[2]).toBeGreaterThan(heights[1]);
  });

  it("floods the crashed screen with `notice` and nothing lit", () => {
    // A crash has to be legible from the color alone, before the face is read.
    const crash = mapNamed("monitor-crash").join("");
    expect(crash).toContain("n");
    expect(crash).not.toContain("c");
  });

  it("leaves the clock's centre clear for the hands", () => {
    // The renderer draws the hands over this face from a `clock` drawable; a
    // baked hub would fight them.
    const clock = mapNamed("clock");
    for (let row = 4; row <= 7; row += 1) {
      expect(clock[row].slice(4, 8), `row ${row}`).toEqual("....");
    }
  });

  it("keeps the sign's field flat so a label can be drawn over it", () => {
    // The cabin name is drawn across rows 3-12; any pattern inside the frame
    // would fight the text at this size.
    const sign = mapNamed("sign");
    for (let row = 3; row <= 12; row += 1) {
      expect(sign[row].slice(3, 29), `row ${row}`).toEqual("B".repeat(26));
    }
  });

  it("keeps floor tiles free of the outline color", () => {
    // An outlined floor tile draws a grid over the entire room.
    for (const entry of officeSpriteMaps()) {
      if (entry.name !== "floor-a" && entry.name !== "floor-b") {
        continue;
      }
      expect(entry.map.join("")).not.toContain("O");
    }
  });
});

describe("rasterizeSpriteMap", () => {
  const FIXTURE = ["ab.", ".ba"];
  const COLORS = new Map([
    ["a", "#ff0000"],
    ["b", "#00ff00"],
  ]);

  it("substitutes colors and leaves `.` transparent", () => {
    const sprite = rasterizeSpriteMap(FIXTURE, COLORS, false);
    expect({ width: sprite.width, height: sprite.height }).toEqual({
      width: 3,
      height: 2,
    });
    expect(pixelAt(sprite, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(sprite, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(sprite, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(sprite, 0, 1)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(sprite, 2, 1)).toEqual([255, 0, 0, 255]);
  });

  it("mirrors each row horizontally when asked", () => {
    const sprite = rasterizeSpriteMap(FIXTURE, COLORS, true);
    expect(pixelAt(sprite, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(sprite, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(sprite, 2, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(sprite, 0, 1)).toEqual([255, 0, 0, 255]);
  });

  it("treats an unresolved letter as transparent rather than throwing", () => {
    const sprite = rasterizeSpriteMap(["ax"], COLORS, false);
    expect(pixelAt(sprite, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it("expands a three-digit hex the same as its six-digit form", () => {
    const short = rasterizeSpriteMap(["a"], new Map([["a", "#f0c"]]), false);
    const long = rasterizeSpriteMap(["a"], new Map([["a", "#ff00cc"]]), false);
    expect(pixelAt(short, 0, 0)).toEqual(pixelAt(long, 0, 0));
  });
});

describe("officePalette", () => {
  it("keeps the two themes distinct on the surfaces characters stand on", () => {
    const dark = officePalette("dark");
    const light = officePalette("light");
    expect(dark.floorBase).not.toEqual(light.floorBase);
    expect(dark.wallLight).not.toEqual(light.wallLight);
  });
});

/**
 * Installs a `getContext` stub and returns its undo.
 *
 * The undo REMOVES the property when there was no own descriptor to put back,
 * rather than redefining it as `undefined`: a host with no `getContext` at all
 * would otherwise be left with a permanent stub, and every later suite in the
 * file would run against it.
 */
function stubGetContext(factory: () => unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: factory,
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      return;
    }
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
  };
}

/** A context that records blits and can also back a rasterized surface. */
function recordingContext(drawn: { count: number }): unknown {
  return {
    drawImage: () => {
      drawn.count += 1;
    },
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: () => undefined,
  };
}

describe("drawOfficeSprite", () => {
  it("draws nothing when the host cannot rasterize a surface", () => {
    // The suite's own `getContext` returns null, which is the jsdom case the
    // guard exists for: the sprite has no surface to blit, so the call must
    // leave the caller's context untouched rather than blitting nothing.
    clearOfficeSpriteCache();
    const drawn = { count: 0 };
    const restore = stubGetContext(() => recordingContext(drawn));
    const ctx = document.createElement("canvas").getContext("2d");
    restore();
    expect(ctx).not.toBeNull();
    if (ctx === null) return;

    drawOfficeSprite(ctx, { name: "desk" }, { x: 16, y: 16 }, "light");

    expect(drawn.count).toBe(0);
  });

  it("blits once per sprite once a surface can be rasterized", () => {
    clearOfficeSpriteCache();
    const drawn = { count: 0 };
    const restore = stubGetContext(() => recordingContext(drawn));
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      expect(ctx).not.toBeNull();
      if (ctx === null) return;

      expect(() => {
        drawOfficeSprite(
          ctx,
          { name: "character", facing: "down", pose: "stand" },
          { x: 0, y: 0 },
          "dark",
        );
        drawOfficeSprite(ctx, { name: "desk" }, { x: 16, y: 16 }, "light");
        drawOfficeSprite(
          ctx,
          { name: "envelope", tint: "#d97757" },
          { x: 4, y: 4 },
          "dark",
        );
      }).not.toThrow();

      // One blit each, and no per-pixel work on the way: three distinct
      // sprites, three rasterizations, three `drawImage` calls.
      expect(drawn.count).toBe(3);
    } finally {
      restore();
    }
  });
});

/** A distinct shirt per index - the key carries the color, so each is a miss. */
function shirtColor(index: number): string {
  return `#${index.toString(16).padStart(6, "0")}`;
}

describe("officeSpriteSurface", () => {
  it("holds the cache to its cap however many agents are drawn", () => {
    // The key carries an agent's APPEARANCE, so without a cap the cache grows
    // by one entry per pose per agent ever seen - across every epic, for as
    // long as the tab lives. Twice the cap of distinct sprites is asked for.
    clearOfficeSpriteCache();
    for (let i = 0; i < OFFICE_SPRITE_CACHE_LIMIT * 2; i += 1) {
      officeSpriteSurface(
        {
          name: "character",
          facing: "down",
          pose: "stand",
          appearance: { ...APPEARANCE, shirt: shirtColor(i) },
        },
        "dark",
      );
    }

    expect(officeSpriteCacheSize()).toBe(OFFICE_SPRITE_CACHE_LIMIT);
  });

  it("evicts the least recently drawn sprite, not the first one drawn", () => {
    // A floor redraws the same few hundred sprites every frame. Evicting by
    // insertion order alone would throw away the floor tile the next frame
    // needs while keeping a sprite nobody has asked for since the tab opened.
    //
    // Surfaces are stubbed into existence here for one reason: a cached
    // surface is the SAME OBJECT on a hit and a new one on a miss, and with
    // jsdom's null surfaces there is nothing to tell the two apart - the cache
    // size is identical either way, since evicting anything keeps it at the
    // cap. Identity is the only honest discriminator.
    clearOfficeSpriteCache();
    const drawn = { count: 0 };
    const restore = stubGetContext(() => recordingContext(drawn));
    try {
      const veteran = {
        name: "character",
        facing: "down",
        pose: "stand",
        appearance: { ...APPEARANCE, shirt: "#ffff00" },
      } as const;
      const first = officeSpriteSurface(veteran, "dark");
      expect(first).not.toBeNull();

      for (let i = 0; i < OFFICE_SPRITE_CACHE_LIMIT - 1; i += 1) {
        officeSpriteSurface(
          {
            name: "character",
            facing: "down",
            pose: "stand",
            appearance: { ...APPEARANCE, shirt: shirtColor(i) },
          },
          "dark",
        );
      }
      expect(officeSpriteCacheSize()).toBe(OFFICE_SPRITE_CACHE_LIMIT);
      // Drawn again: the veteran is now the YOUNGEST entry, and the oldest is
      // the first sprite of the loop above.
      officeSpriteSurface(veteran, "dark");

      officeSpriteSurface(
        {
          name: "character",
          facing: "down",
          pose: "stand",
          appearance: { ...APPEARANCE, shirt: "#ff00ff" },
        },
        "dark",
      );

      expect(officeSpriteCacheSize()).toBe(OFFICE_SPRITE_CACHE_LIMIT);
      // The same surface, so the newcomer displaced the loop's first sprite -
      // insertion order would have displaced this one.
      expect(officeSpriteSurface(veteran, "dark")).toBe(first);
    } finally {
      restore();
    }
  });
});
