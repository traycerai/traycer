import { describe, expect, it } from "vitest";
import { tabAutoTint } from "../tab-identity";

/** The hues D11 leaves out: amber, red and the info blue that marks unread. */
const FORBIDDEN_HUE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 60], // red/amber
  [210, 260], // the info blue range
];

function hueOf(tint: string): number {
  const match = /oklch\([\d.]+ [\d.]+ (\d+)\)/.exec(tint);
  if (match === null) throw new Error(`no oklch hue in ${tint}`);
  return Number(match[1]);
}

describe("tabAutoTint", () => {
  // A literal, not a second call: the hash has to agree across sessions and
  // machines, so a change to it (or to the hue table) must show up here.
  it("is stable for the same epic id", () => {
    expect(tabAutoTint("epic-123")).toBe(
      "light-dark(oklch(0.6 0.13 140), oklch(0.72 0.12 140))",
    );
  });

  it("returns a light-dark() oklch pair", () => {
    const tint = tabAutoTint("epic-abc");
    expect(tint).toMatch(
      /^light-dark\(oklch\([\d.]+ [\d.]+ \d+\), oklch\([\d.]+ [\d.]+ \d+\)\)$/,
    );
  });

  it("spreads distinct ids over the palette and never lands on a status hue", () => {
    const hues = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      const hue = hueOf(tabAutoTint(`epic-${String(index)}`));
      hues.add(hue);
      for (const [from, to] of FORBIDDEN_HUE_RANGES) {
        expect(hue < from || hue > to).toBe(true);
      }
    }
    // 200 ids over a 10-hue table: nearly every hue is reached.
    expect(hues.size).toBeGreaterThanOrEqual(8);
  });

  it("uses the same hue for both the light and dark oklch calls", () => {
    const tint = tabAutoTint("epic-xyz");
    const hues = [...tint.matchAll(/oklch\([\d.]+ [\d.]+ (\d+)\)/g)].map(
      (match) => match[1],
    );
    expect(hues).toHaveLength(2);
    expect(hues[0]).toBe(hues[1]);
  });
});
