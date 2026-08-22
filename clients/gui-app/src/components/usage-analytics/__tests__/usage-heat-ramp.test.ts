import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The activity heatmap's `--usage-heat-N` ramp must get DARKER as the level
 * rises, in both modes: the legend reads "Fewer → More" and GitHub trained
 * everyone that the deep tile is the busy day. Dark mode once ran the other
 * way (dark→bright), so the busiest day rendered as the palest tile. The
 * ramp is CSS, which no component test sees - so this reads the stylesheet
 * and checks the lightness order directly.
 */
const CSS = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/usage-analytics-chart.css",
  ),
  "utf8",
);

function rampIn(block: string): readonly number[] {
  const body = CSS.slice(CSS.indexOf(block));
  const scope = body.slice(0, body.indexOf("}"));
  return [1, 2, 3, 4].map((level) => {
    const match = new RegExp(
      `--usage-heat-${String(level)}:\\s*#([0-9a-fA-F]{6})`,
    ).exec(scope);
    if (match?.[1] === undefined) {
      throw new Error(`missing --usage-heat-${String(level)} in ${block}`);
    }
    return relativeLuminance(match[1]);
  });
}

/** WCAG relative luminance of a 6-digit hex color. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function expectStrictlyDarkening(ramp: readonly number[]): void {
  for (let level = 1; level < ramp.length; level++) {
    expect(ramp[level]).toBeLessThan(ramp[level - 1] ?? Number.NaN);
  }
}

describe("--usage-heat ramp", () => {
  it("darkens with every level in light mode", () => {
    expectStrictlyDarkening(rampIn(".usage-chart-root {"));
  });

  it("darkens with every level in dark mode too - the busiest day is never the palest tile", () => {
    expectStrictlyDarkening(rampIn(".dark .usage-chart-root {"));
  });
});
