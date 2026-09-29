/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compositeOverBackground,
  contrastRatio,
  resolveThemeTokens,
  themePresets,
  themeToken,
  type ResolvedThemeMode,
} from "@/../__tests__/contrast";

/**
 * Checkbox and RadioGroupItem outline their unchecked box in a colour token
 * rather than `--input` (~1.2:1 on the default light background), so the box
 * stays visible on every surface, including a selected layout row's
 * `bg-foreground/6` tint - the surface it originally vanished on. The token
 * and its alpha are read out of the source, so a change to either is measured
 * here against every palette instead of silently reopening the bug.
 */

const uiDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "ui",
);

interface UncheckedBorder {
  readonly token: string;
  readonly alpha: number;
}

/**
 * The `border border-<token>[/<alpha>]` pair on the unchecked box, read from
 * `fromFunction` onward: `radio-group.tsx` carries a SECOND "border
 * border-<token>" pair on its group wrapper (the segmented/row variants),
 * so matching the whole file risks picking that one up instead of the dot.
 */
function uncheckedBorder(
  componentFile: string,
  fromFunction: string,
): UncheckedBorder {
  const whole = readFileSync(path.join(uiDir, componentFile), "utf8");
  const start = whole.indexOf(`function ${fromFunction}(`);
  if (start === -1) {
    throw new Error(`${componentFile}: expected a function ${fromFunction}`);
  }
  const source = whole.slice(start);
  const match = /\bborder border-([a-z-]+)(?:\/(\d+))?\s/.exec(source);
  if (match === null) {
    throw new Error(
      `${componentFile}: expected a "border border-<token>" pair in ${fromFunction}`,
    );
  }
  // `.at` types the optional alpha group as possibly absent, as it is.
  const alpha = match.at(2);
  return {
    token: `--${match[1]}`,
    alpha: alpha === undefined ? 1 : Number(alpha) / 100,
  };
}

/**
 * The off Switch's track border and thumb: `data-unchecked:<utility>-<token>`
 * in switch.tsx, the first for the track and the second for the thumb.
 */
function switchOffTokens(): {
  readonly border: string;
  readonly thumb: string;
} {
  const source = readFileSync(path.join(uiDir, "switch.tsx"), "utf8");
  const border = /data-unchecked:border-([a-z-]+)\s/.exec(source);
  const thumbs = [...source.matchAll(/data-unchecked:bg-([a-z-]+)(?=[\s"])/g)];
  const thumb = thumbs.at(-1);
  if (border === null || thumb === undefined) {
    throw new Error("switch.tsx: expected an unchecked border and thumb token");
  }
  return { border: `--${border[1]}`, thumb: `--${thumb[1]}` };
}

const SWITCH_OFF = switchOffTokens();
const UNCHECKED_OUTLINES: ReadonlyArray<readonly [string, UncheckedBorder]> = [
  ["checkbox", uncheckedBorder("checkbox.tsx", "Checkbox")],
  ["radio", uncheckedBorder("radio-group.tsx", "RadioGroupItem")],
];
const MIN_CONTRAST = 3;

describe("unchecked checkbox/radio border and off switch contrast", () => {
  it.each(["light", "dark"] as const)(
    "clears 3:1 against background/card/popover and the selected-row tint in every preset, mode=%s",
    (mode: ResolvedThemeMode) => {
      const violations: string[] = [];
      for (const preset of themePresets()) {
        const tokens = resolveThemeTokens(preset, mode);
        const foreground = themeToken(tokens, "--foreground");
        const background = themeToken(tokens, "--background");
        const surfaces: Record<string, string> = {
          background,
          card: themeToken(tokens, "--card"),
          popover: themeToken(tokens, "--popover"),
          "selected-row (bg-foreground/6 over background)":
            compositeOverBackground(foreground, 0.06, background),
        };
        for (const [surfaceName, surfaceColor] of Object.entries(surfaces)) {
          // An off Switch: its track outline and its thumb, which sits on a
          // track filled with a faint `--input`, so it is measured against
          // the surface under that fill as the worst case of the two.
          for (const [part, token] of [
            ["switch track border", SWITCH_OFF.border],
            ["switch thumb", SWITCH_OFF.thumb],
          ] as const) {
            const partContrast = contrastRatio(
              themeToken(tokens, token),
              surfaceColor,
            );
            if (partContrast < MIN_CONTRAST) {
              violations.push(
                `${preset}/${surfaceName}: ${part} contrast ${partContrast.toFixed(4)} (${token})`,
              );
            }
          }
          for (const [control, outline] of UNCHECKED_OUTLINES) {
            const drawn = compositeOverBackground(
              themeToken(tokens, outline.token),
              outline.alpha,
              surfaceColor,
            );
            const contrast = contrastRatio(drawn, surfaceColor);
            if (contrast < MIN_CONTRAST) {
              violations.push(
                `${preset}/${surfaceName}: ${control} contrast ${contrast.toFixed(4)} (${outline.token} at ${outline.alpha})`,
              );
            }
          }
        }
      }
      expect(violations).toEqual([]);
    },
  );
});
