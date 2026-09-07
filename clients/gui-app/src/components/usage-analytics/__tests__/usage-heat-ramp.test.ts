import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** These are 10px borderless marks - separation from the surface is their only channel. */
const CSS = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/usage-analytics-chart.css",
  ),
  "utf8",
);

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
    // A light→dark dark-mode ramp puts level 4 at 1.30:1 on nord - fainter than level 1 - so assert the ordering
    // that a re-flip would break, plus a floor no flip survives.
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
