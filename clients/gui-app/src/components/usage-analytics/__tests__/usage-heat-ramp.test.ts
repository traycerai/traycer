import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The activity heatmap's `--usage-heat-N` ramp follows GitHub's contribution
 * graph, which does NOT use one direction for both modes:
 *
 *   light  #9be9a8 → #216e39   (light → dark)
 *   dark   #0e4429 → #39d353   (dark → bright)
 *
 * "Busier" means "further from the surface", and on a dark canvas that is
 * brighter. Flipping dark mode to light→dark for symmetry reads as a bug fix
 * and is not one: it sinks the busiest tile to ~1.3:1 against the dark preset
 * cards while the quietest sits above 6:1, so the emptiest days become the
 * loudest marks. These are 10px borderless marks - separation from the
 * surface is their only channel.
 *
 * The ramp is CSS, which no component test sees, so this reads the
 * stylesheet directly and pins both the direction and the contrast floor
 * that makes the direction matter.
 */
const CSS = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/usage-analytics-chart.css",
  ),
  "utf8",
);

/** WCAG relative luminance of a `#rrggbb` color. */
function relativeLuminance(color: string): number {
  const hex = color.replace("#", "");
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const hi = Math.max(first, second);
  const lo = Math.min(first, second);
  return (hi + 0.05) / (lo + 0.05);
}

/** The four active steps of one `.usage-chart-root` block, level 1 → 4. */
function rampIn(blockSelector: string): readonly string[] {
  const start = CSS.indexOf(blockSelector);
  if (start < 0) throw new Error(`missing block ${blockSelector}`);
  const scope = CSS.slice(start, CSS.indexOf("}", start));
  return [1, 2, 3, 4].map((level) => {
    const match = new RegExp(
      `--usage-heat-${String(level)}:\\s*(#[0-9a-fA-F]{6})`,
    ).exec(scope);
    if (match?.[1] === undefined) {
      throw new Error(
        `missing --usage-heat-${String(level)} in ${blockSelector}`,
      );
    }
    return match[1];
  });
}

const LIGHT = ".usage-chart-root {";
const DARK = ".dark .usage-chart-root {";

/** Every dark surface the Usage panels actually render on (`--card` per preset). */
const DARK_CARDS: ReadonlyArray<readonly [string, string]> = [
  ["default", "#343434"],
  ["neutral", "#1a1a1a"],
  ["everforest", "#1a2421"],
  ["dracula", "#343746"],
  ["catppuccin", "#313244"],
  ["github", "#161b22"],
  ["gruvbox", "#32302f"],
  ["tokyo-night", "#24283b"],
  ["nord", "#3b4252"],
];

describe("--usage-heat ramp", () => {
  it("darkens with every level in light mode", () => {
    const ramp = rampIn(LIGHT).map(relativeLuminance);
    for (let level = 1; level < ramp.length; level++) {
      expect(ramp[level]).toBeLessThan(ramp[level - 1]);
    }
  });

  it("brightens with every level in dark mode, as GitHub's dark ramp does", () => {
    const ramp = rampIn(DARK).map(relativeLuminance);
    for (let level = 1; level < ramp.length; level++) {
      expect(ramp[level]).toBeGreaterThan(ramp[level - 1]);
    }
  });

  it("keeps the busiest dark tile the most separated one on every preset card", () => {
    // The reason the dark ramp inverts. A light→dark dark-mode ramp puts
    // level 4 at 1.30:1 on nord - fainter than level 1 - so assert the
    // ordering that a re-flip would break, plus a floor no flip survives.
    const dark = rampIn(DARK);
    const faintest = dark[0];
    const busiest = dark[3];
    for (const [preset, card] of DARK_CARDS) {
      const busiestContrast = contrastRatio(busiest, card);
      expect(
        busiestContrast,
        `level 4 must out-separate level 1 on ${preset}`,
      ).toBeGreaterThan(contrastRatio(faintest, card));
      expect(
        busiestContrast,
        `level 4 must stay visible on ${preset}`,
      ).toBeGreaterThan(3);
    }
  });
});
