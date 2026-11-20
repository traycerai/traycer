/**
 * A saved colour is drawn on its own hue, whether or not the settings still
 * offer it: the line-up is replaced here by other lists, and nothing a bot
 * draws changes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@traycer/protocol/host/bot/colors", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@traycer/protocol/host/bot/colors")>();
  return {
    ...actual,
    BOT_COLOR_LINE_UP: [
      { name: "Only", hex: "#123456" },
      ...[...actual.BOT_COLOR_LINE_UP].reverse(),
    ],
  };
});

import { BOT_COLOR_LINE_UP } from "@traycer/protocol/host/bot/colors";
import { botMascot } from "@/lib/bots/mascot-mark";

const BOT_ID = "bot_0KNEF4PC1F8D0H626S5VEKEQ8Y";

/** A colour's hue in degrees, worked out here from its own red, green and blue. */
function hueOfHex(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(
    (at) => parseInt(hex.slice(at, at + 2), 16) / 255,
  );
  const high = Math.max(r, g, b);
  const spread = high - Math.min(r, g, b);
  if (spread === 0) return 0;
  let sector = (r - g) / spread + 4;
  if (high === r) sector = ((g - b) / spread) % 6;
  else if (high === g) sector = (b - r) / spread + 2;
  return (sector * 60 + 360) % 360;
}

/** The hue a mascot of colour `color` is drawn on. */
function drawnHue(color: string): number {
  const look = { mark: null, color, eyewear: null, accessory: null };
  return botMascot(BOT_ID, look, false).ramp.hue;
}

const SPAN = 360;
const apart = (a: number, b: number): number => {
  const gap = Math.abs(a - b) % SPAN;
  return Math.min(gap, SPAN - gap);
};

describe("drawing a saved colour with the line-up changed", () => {
  it("has replaced the line-up the settings read", () => {
    expect(BOT_COLOR_LINE_UP[0].hex).toBe("#123456");
    expect(BOT_COLOR_LINE_UP).toHaveLength(10);
  });

  it.each([
    ["red, once first of nine and now last", "#f04c4c"],
    ["blue, listed at another place now", "#4c8af0"],
    ["a colour no line-up has ever listed", "#4cf06b"],
  ])("draws %s on its own hue", (_name, hex) => {
    expect(apart(drawnHue(hex), hueOfHex(hex))).toBeLessThanOrEqual(1);
  });

  it("draws two colours of the line-up on hues that stay apart, whatever their places", () => {
    expect(apart(drawnHue("#f04c4c"), drawnHue("#4c8af0"))).toBeGreaterThan(90);
  });
});
