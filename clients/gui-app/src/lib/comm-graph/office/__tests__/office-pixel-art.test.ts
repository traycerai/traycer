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
import type { OfficeAppearance } from "@/lib/comm-graph/office/office-types";

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
