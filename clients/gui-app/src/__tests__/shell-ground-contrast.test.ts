/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { converter } from "culori";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  resolveThemeTokens,
  themePresets,
  themeToken,
  type ResolvedThemeMode,
} from "@/../__tests__/contrast";

/**
 * `--shell-ground` (ticket 02, D1/D2): `oklch(from var(--canvas) max(calc(l -
 * X), calc(X - l)) c h)`, i.e. groundL = |canvasL - X|, has to read as a
 * distinct surface from BOTH `--canvas` and `--background` in every builtin
 * preset, light and dark - including Amoled's pure-black canvas, which a
 * plain `l - X` would clamp to 0 (the old `color-mix(..., black)` token's
 * 1:1 ground). This is structural surface differentiation, not text
 * contrast: the header/strip go transparent over the ground and can still
 * carry text on it, so this asserts a real, non-collapsing separation, not
 * WCAG's 3:1 indicator bar.
 */

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.css"),
  "utf8",
);

const OFFSETS =
  /--shell-ground:\s*light-dark\(\s*oklch\(from var\(--canvas\) max\(calc\(l - ([\d.]+)\), calc\(([\d.]+) - l\)\) c h\),\s*oklch\(from var\(--canvas\) max\(calc\(l - ([\d.]+)\), calc\(([\d.]+) - l\)\) c h\)\s*\)/.exec(
    css,
  );
if (OFFSETS === null) {
  throw new Error(
    "--shell-ground: not the expected |canvasL - X| relative-colour idiom",
  );
}
const [, lightLow, lightHigh, darkLow, darkHigh] = OFFSETS;
const LIGHT_OFFSET = Number(lightLow);
const DARK_OFFSET = Number(darkLow);
const toOklch = converter("oklch");

/** Parses a validated theme token; throws by name rather than defaulting. */
function parseOklch(token: string): {
  l: number;
  c: number;
  h: number | undefined;
} {
  const parsed = toOklch(token);
  if (parsed === undefined) throw new Error(`could not parse colour: ${token}`);
  return { l: parsed.l, c: parsed.c, h: parsed.h };
}

// Floors below the weakest measured case per mode (tokyo-night/light/background
// ΔL ~0.0399, github/dark/background ΔL ~0.1002), so a real regression fails
// while float rounding across presets does not.
const MIN_DELTA_L: Record<ResolvedThemeMode, number> = {
  light: 0.035,
  dark: 0.09,
};
const MIN_CONTRAST: Record<ResolvedThemeMode, number> = {
  light: 1.05,
  dark: 1.005,
};

describe("--shell-ground", () => {
  it("mixes |canvasL - X| in both branches, offsets read off index.css", () => {
    expect(lightLow).toBe(lightHigh);
    expect(darkLow).toBe(darkHigh);
    // Amoled's L:0 canvas needs to travel further before it reads as a
    // distinct dark surface at all.
    expect(DARK_OFFSET).toBeGreaterThan(LIGHT_OFFSET);
  });

  it.each(["light", "dark"] as const)(
    "stays a real, non-collapsing surface from --canvas and --background in every preset, mode=%s",
    (mode) => {
      const offset = mode === "light" ? LIGHT_OFFSET : DARK_OFFSET;
      const violations: string[] = [];
      for (const preset of themePresets()) {
        const tokens = resolveThemeTokens(preset, mode);
        const canvas = parseOklch(themeToken(tokens, "--canvas"));
        const groundL = Math.abs(canvas.l - offset);
        const groundCss = `oklch(${groundL.toFixed(6)} ${canvas.c.toFixed(6)} ${(canvas.h ?? 0).toFixed(6)})`;
        for (const surface of ["canvas", "background"] as const) {
          const surfaceToken = themeToken(tokens, `--${surface}`);
          const surfaceL = parseOklch(surfaceToken).l;
          const deltaL = Math.abs(groundL - surfaceL);
          const contrast = contrastRatio(groundCss, surfaceToken);
          if (deltaL < MIN_DELTA_L[mode] || contrast < MIN_CONTRAST[mode]) {
            violations.push(
              `${preset}/${surface}: ΔL ${deltaL.toFixed(4)} (floor ${MIN_DELTA_L[mode]}), contrast ${contrast.toFixed(4)} (floor ${MIN_CONTRAST[mode]})`,
            );
          }
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it("reflects Amoled's pure-black dark canvas up to a non-zero ground - the case the reflection exists for", () => {
    const tokens = resolveThemeTokens("amoled", "dark");
    const canvas = parseOklch(themeToken(tokens, "--canvas"));
    expect(canvas.l).toBe(0);
    expect(Math.abs(canvas.l - DARK_OFFSET)).toBeCloseTo(DARK_OFFSET, 5);
  });
});
