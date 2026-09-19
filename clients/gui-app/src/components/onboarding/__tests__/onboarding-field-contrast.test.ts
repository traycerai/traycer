import { describe, expect, it } from "vitest";
import { parse, rgb, wcagContrast, type Rgb } from "culori";
import { THEME_PRESETS } from "@/lib/theme-presets";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import { isThemeToken, type ThemeToken } from "@/lib/themes/theme-definition";
import {
  onboardingFieldLuminance,
  onboardingFieldPeakAlpha,
  onboardingFieldWorstCaseMix,
  type OnboardingFieldRgb,
} from "@/components/onboarding/onboarding-field-alpha";

/**
 * The welcome field paints over the page's own ground, and the welcome copy
 * paints over the field. This pins the one thing that has to stay true of that
 * sandwich on every theme the app ships: the brightest dot the field can draw
 * still leaves `--foreground` readable on it.
 *
 * It is the shader's arithmetic, not a screenshot: the peak alpha and the
 * worst-case mix come from `onboarding-field-alpha.ts`, which is the same
 * module the shader takes its `uPeakAlpha` uniform from.
 */

const APPEARANCES = ["light", "dark"] as const;
const WCAG_AA_BODY = 4.5;

type ThemeColors = Partial<Record<ThemeToken, string>>;

/** Resolves a token, following the one `var(--other-token)` form the palettes use. */
function tokenColor(colors: ThemeColors, token: string): string {
  const raw = isThemeToken(token) ? colors[token] : undefined;
  if (raw === undefined) throw new Error(`palette has no --${token}`);
  const reference = /^var\(--([\w-]+)\)$/.exec(raw);
  if (reference === null) return raw;
  return tokenColor(colors, reference[1]);
}

function toRgb(value: string): Rgb {
  const parsed = rgb(parse(value));
  if (parsed === undefined) throw new Error(`unparseable colour: ${value}`);
  return parsed;
}

function channels(color: Rgb): OnboardingFieldRgb {
  return [color.r, color.g, color.b];
}

/** `mix(ground, primary, amount)`, the way the shader and the canvas compose it. */
function mixed(ground: Rgb, primary: Rgb, amount: number): Rgb {
  return {
    mode: "rgb",
    r: ground.r + (primary.r - ground.r) * amount,
    g: ground.g + (primary.g - ground.g) * amount,
    b: ground.b + (primary.b - ground.b) * amount,
  };
}

interface FieldCase {
  readonly name: string;
  readonly peakAlpha: number;
  readonly contrast: number;
}

const cases: readonly FieldCase[] = THEME_PRESETS.flatMap((preset) =>
  APPEARANCES.map((appearance): FieldCase => {
    const colors = getBuiltinThemeColors(preset.id, appearance);
    const ground = toRgb(tokenColor(colors, "background"));
    const primary = toRgb(tokenColor(colors, "primary"));
    const foreground = tokenColor(colors, "foreground");
    const peakAlpha = onboardingFieldPeakAlpha(
      onboardingFieldLuminance(channels(ground)),
    );
    const worst = mixed(
      ground,
      primary,
      onboardingFieldWorstCaseMix(peakAlpha),
    );
    return {
      name: `${preset.id} ${appearance}`,
      peakAlpha,
      contrast: wcagContrast(foreground, worst),
    };
  }),
);

describe("onboarding welcome field contrast", () => {
  it("covers every builtin palette in both appearances", () => {
    expect(cases).toHaveLength(THEME_PRESETS.length * 2);
    expect(THEME_PRESETS.length).toBeGreaterThan(10);
  });

  it.each(cases)(
    "keeps --foreground readable over the brightest dot on $name",
    (entry) => {
      expect(entry.contrast).toBeGreaterThanOrEqual(WCAG_AA_BODY);
    },
  );

  it("never lets a mid-luminance ground carry the full field", () => {
    // The band that motivated this: the dark preset alphas must not leak onto
    // a ground bright enough to compete with the copy.
    expect(onboardingFieldPeakAlpha(0.5)).toBeLessThan(
      onboardingFieldPeakAlpha(0),
    );
    expect(onboardingFieldPeakAlpha(0.5)).toBeLessThan(
      onboardingFieldPeakAlpha(1),
    );
  });
});
