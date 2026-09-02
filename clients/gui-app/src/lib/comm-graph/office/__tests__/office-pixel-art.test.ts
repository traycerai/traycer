import { afterEach, describe, expect, it } from "vitest";
import {
  clearOfficeSpriteCache,
  drawOfficeSprite,
  officePalette,
  officeSpriteColors,
  officeSpriteMaps,
  officeSpriteSize,
  rasterizeSpriteMap,
  OFFICE_SPRITE_LETTERS,
  type RasterizedSprite,
} from "@/lib/comm-graph/office/office-pixel-art";
import type {
  OfficeAppearance,
  OfficeSpriteName,
} from "@/lib/comm-graph/office/office-types";

/**
 * Every sprite the union names. Written as a record rather than an array so the
 * compiler rejects a name added to `OfficeSpriteName` and forgotten here - which
 * is the failure this file exists to catch, since the map registry is a
 * hand-maintained list and an unregistered map is simply never asserted on.
 */
const ALL_SPRITE_NAMES: Readonly<Record<OfficeSpriteName, true>> = {
  character: true,
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

  it("alternates the two lit monitor frames without moving the chassis", () => {
    // The scene swaps these two frames while an agent works. Differing screen
    // rows are what reads as scrolling code; a differing BEZEL would read as
    // the whole monitor twitching, which is why the frame rows are pinned.
    const frameA = mapNamed("monitor-on");
    const frameB = mapNamed("monitor-on-b");
    const chassisRows = [0, 1, 9, 10, 11];
    for (const row of chassisRows) {
      expect(frameB[row], `row ${row}`).toEqual(frameA[row]);
    }
    const screenRows = [2, 3, 4, 5, 6, 7, 8];
    expect(screenRows.map((row) => frameB[row]).join("")).not.toEqual(
      screenRows.map((row) => frameA[row]).join(""),
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
      ];
    for (const [name, width, height] of expected) {
      expect(officeSpriteSize({ name }), name).toEqual({ width, height });
    }
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

  it("alternates the two lit wide frames without moving the chassis", () => {
    // Same contract as the single monitor's two frames: the bezel and the stand
    // are pinned so only the code lines move.
    const frameA = mapNamed("monitor-wide-on");
    const frameB = mapNamed("monitor-wide-on-b");
    const chassisRows = [0, 1, 9, 10, 11];
    for (const row of chassisRows) {
      expect(frameB[row], `row ${row}`).toEqual(frameA[row]);
    }
    const screenRows = [2, 3, 4, 5, 6, 7, 8];
    expect(screenRows.map((row) => frameB[row]).join("")).not.toEqual(
      screenRows.map((row) => frameA[row]).join(""),
    );
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

describe("drawOfficeSprite", () => {
  it("is a silent no-op when the host has no 2D context", () => {
    // The suite stubs `getContext` to null, which is exactly the jsdom case the
    // guard exists for. Borrow a typed context from a temporary stub so the
    // call is made the way a real caller makes it.
    const original = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage: () => undefined }),
    });
    const ctx = document.createElement("canvas").getContext("2d");
    if (original !== undefined) {
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        "getContext",
        original,
      );
    }
    expect(ctx).not.toBeNull();
    if (ctx === null) {
      return;
    }

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
  });
});
