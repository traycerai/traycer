import { z } from "zod";
import { formatHex8, parse, rgb, wcagContrast } from "culori";
import { THEME_PRESETS, type ThemePreset } from "../theme-presets";

/** The editable contract. Only literal colors and these semantic roles cross the import boundary. */
export const themeTokens = [
  { key: "background", label: "Background", group: "Surfaces" },
  { key: "foreground", label: "Text", group: "Surfaces" },
  { key: "canvas", label: "Canvas", group: "Surfaces" },
  { key: "canvas-foreground", label: "Canvas foreground", group: "Surfaces" },
  { key: "canvas-border", label: "Canvas border", group: "Surfaces" },
  { key: "card", label: "Surface", group: "Surfaces" },
  { key: "card-foreground", label: "Surface text", group: "Surfaces" },
  { key: "popover", label: "Menus and dialogs", group: "Surfaces" },
  { key: "popover-foreground", label: "Menu text", group: "Surfaces" },
  { key: "sidebar", label: "Sidebar", group: "Surfaces" },
  { key: "sidebar-foreground", label: "Sidebar foreground", group: "Surfaces" },
  { key: "primary", label: "Primary", group: "Controls" },
  { key: "primary-foreground", label: "Primary text", group: "Controls" },
  { key: "secondary", label: "Secondary", group: "Controls" },
  {
    key: "secondary-foreground",
    label: "Secondary foreground",
    group: "Controls",
  },
  { key: "muted", label: "Muted surface", group: "Controls" },
  { key: "muted-foreground", label: "Secondary text", group: "Controls" },
  { key: "accent", label: "Accent", group: "Controls" },
  { key: "accent-foreground", label: "Accent foreground", group: "Controls" },
  { key: "border", label: "Border", group: "Controls" },
  { key: "input", label: "Input", group: "Controls" },
  { key: "ring", label: "Focus ring", group: "Controls" },
  { key: "destructive", label: "Destructive", group: "Status" },
  { key: "success", label: "Success", group: "Status" },
  { key: "success-foreground", label: "Success foreground", group: "Status" },
  { key: "warning", label: "Warning", group: "Status" },
  { key: "warning-foreground", label: "Warning foreground", group: "Status" },
  { key: "chart-1", label: "Chart 1", group: "Charts" },
  { key: "chart-2", label: "Chart 2", group: "Charts" },
  { key: "chart-3", label: "Chart 3", group: "Charts" },
  { key: "chart-4", label: "Chart 4", group: "Charts" },
  { key: "chart-5", label: "Chart 5", group: "Charts" },
  { key: "term-background", label: "Terminal background", group: "Terminal" },
  { key: "term-foreground", label: "Terminal foreground", group: "Terminal" },
  { key: "term-cursor", label: "Terminal cursor", group: "Terminal" },
  { key: "term-selection", label: "Terminal selection", group: "Terminal" },
  { key: "term-ansi-black", label: "Ansi black", group: "Terminal" },
  { key: "term-ansi-red", label: "Ansi red", group: "Terminal" },
  { key: "term-ansi-green", label: "Ansi green", group: "Terminal" },
  { key: "term-ansi-yellow", label: "Ansi yellow", group: "Terminal" },
  { key: "term-ansi-blue", label: "Ansi blue", group: "Terminal" },
  { key: "term-ansi-magenta", label: "Ansi magenta", group: "Terminal" },
  { key: "term-ansi-cyan", label: "Ansi cyan", group: "Terminal" },
  { key: "term-ansi-white", label: "Ansi white", group: "Terminal" },
  {
    key: "term-ansi-bright-black",
    label: "Ansi bright black",
    group: "Terminal",
  },
  { key: "term-ansi-bright-red", label: "Ansi bright red", group: "Terminal" },
  {
    key: "term-ansi-bright-green",
    label: "Ansi bright green",
    group: "Terminal",
  },
  {
    key: "term-ansi-bright-yellow",
    label: "Ansi bright yellow",
    group: "Terminal",
  },
  {
    key: "term-ansi-bright-blue",
    label: "Ansi bright blue",
    group: "Terminal",
  },
  {
    key: "term-ansi-bright-magenta",
    label: "Ansi bright magenta",
    group: "Terminal",
  },
  {
    key: "term-ansi-bright-cyan",
    label: "Ansi bright cyan",
    group: "Terminal",
  },
  {
    key: "term-ansi-bright-white",
    label: "Ansi bright white",
    group: "Terminal",
  },
] as const;
export type ThemeToken = (typeof themeTokens)[number]["key"];
export const themeTokenNames = themeTokens.map((token) => token.key);
export function isThemeToken(value: string): value is ThemeToken {
  return themeTokens.some((token) => token.key === value);
}
export function normalizeThemeColor(value: string): string | null {
  if (value.length > 128) return null;
  const color = parse(value.trim());
  if (!color) return null;
  const channels = rgb(color);
  if (
    ![channels.r, channels.g, channels.b, channels.alpha ?? 1].every(
      Number.isFinite,
    )
  )
    return null;
  return formatHex8(channels);
}
const colorSchema = z
  .string()
  .max(128)
  .transform((value, ctx) => {
    const color = normalizeThemeColor(value);
    if (color === null) {
      ctx.addIssue({ code: "custom", message: "Use a literal CSS color." });
      return z.NEVER;
    }
    return color;
  });
const syntaxRuleSchema = z.object({
  name: z.string().max(256).optional(),
  scope: z
    .union([z.string().max(4096), z.array(z.string().max(4096)).max(128)])
    .optional(),
  settings: z.object({
    foreground: colorSchema.optional(),
    background: colorSchema.optional(),
    fontStyle: z
      .string()
      .regex(/^(?:(?:italic|bold|underline|strikethrough)\s*)*$/)
      .optional(),
  }),
});
export const themeSyntaxSchema = z.object({
  colors: z.record(z.string().max(128), colorSchema),
  tokenColors: z.array(syntaxRuleSchema).max(4096),
});
export type ThemeSyntax = z.infer<typeof themeSyntaxSchema>;
export const themeDefinitionSchema = z.object({
  version: z.literal(1),
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  name: z.string().trim().min(1).max(100),
  appearance: z.enum(["light", "dark"]),
  base: z.custom<ThemePreset>((value) =>
    THEME_PRESETS.some((preset) => preset.id === value),
  ),
  colors: z.partialRecord(z.enum(themeTokenNames), colorSchema),
  syntax: themeSyntaxSchema.nullable(),
  sidebarArtwork: z.boolean().optional(),
  collection: z
    .object({ id: z.string().max(256), name: z.string().max(100) })
    .optional(),
});
export type ThemeDefinition = z.infer<typeof themeDefinitionSchema>;

/** Guided edits derive surface roles once; advanced edits can override each role. */
export function deriveThemeColors(
  background: string,
  accent: string,
  appearance: "light" | "dark",
): Partial<Record<ThemeToken, string>> {
  const bg = rgb(
    parse(background) ?? {
      mode: "rgb",
      r: appearance === "dark" ? 0.1 : 0.98,
      g: appearance === "dark" ? 0.1 : 0.98,
      b: appearance === "dark" ? 0.1 : 0.98,
    },
  );
  const ink =
    wcagContrast(bg, "#ffffff") > wcagContrast(bg, "#171717")
      ? "#ffffff"
      : "#171717";
  const foreground =
    ink === "#ffffff" ? { r: 1, g: 1, b: 1 } : { r: 0.09, g: 0.09, b: 0.09 };
  const mix = (amount: number) =>
    formatHex8({
      mode: "rgb",
      r: bg.r + (foreground.r - bg.r) * amount,
      g: bg.g + (foreground.g - bg.g) * amount,
      b: bg.b + (foreground.b - bg.b) * amount,
    });
  const primary = normalizeThemeColor(accent) ?? "#3b82f6ff";
  return {
    background: formatHex8(bg),
    foreground: ink,
    canvas: formatHex8(bg),
    "canvas-foreground": ink,
    "canvas-border": mix(0.18),
    card: mix(0.035),
    "card-foreground": ink,
    popover: mix(0.055),
    "popover-foreground": ink,
    sidebar: mix(0.025),
    "sidebar-foreground": ink,
    primary,
    "primary-foreground":
      wcagContrast(primary, "#ffffff") > wcagContrast(primary, "#171717")
        ? "#ffffff"
        : "#171717",
    secondary: mix(0.08),
    "secondary-foreground": ink,
    muted: mix(0.06),
    "muted-foreground": mix(0.65),
    accent: mix(0.1),
    "accent-foreground": ink,
    border: mix(0.18),
    input: mix(0.22),
    ring: primary,
    "term-background": formatHex8(bg),
    "term-foreground": ink,
    "term-cursor": ink,
    "term-selection": primary.slice(0, 7) + "55",
  };
}

/**
 * VS Code borders can be transparent or match surfaces that differ in
 * Traycer. Returns only the tokens it had to fix up, rather than mutating
 * `colors` in place, so a caller decides when and how to merge them.
 */
// culori's `wcagContrast` computes relative luminance from RGB channels only
// and ignores alpha (verified against culori 4.0.2 - `wcagContrast` on a 5%-
// opaque white over black returns 21, identical to fully opaque white). A VS
// Code border token can be genuinely translucent (`normalizeThemeColor`
// preserves alpha), so judging it unmodified reports full contrast for a
// border that is nearly invisible once actually composited onto its surface.
// Composite first so the check measures the same pixel the page renders.
function compositeOverSurface(color: string, surface: string): string {
  const fg = rgb(parse(color));
  const bg = rgb(parse(surface));
  if (!fg || !bg) return color;
  const alpha = fg.alpha ?? 1;
  return formatHex8({
    mode: "rgb",
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  });
}

export function ensureVisibleThemeBorders(
  colors: ThemeDefinition["colors"],
): Partial<Record<ThemeToken, string>> {
  const overrides: Partial<Record<ThemeToken, string>> = {};
  for (const token of ["canvas-border", "border", "input"] as const) {
    const surfaces = (
      token === "canvas-border"
        ? [colors.canvas]
        : [colors.background, colors.card, colors.popover, colors.sidebar]
    ).filter((color): color is string => color !== undefined);
    const original = colors[token];
    if (!original || surfaces.length === 0) continue;
    // Loop-invariant across every step below: the surfaces a candidate is
    // judged against, and the minimum contrast a color reaches over them.
    // A candidate this loop generates is already opaque (the interpolation
    // below omits alpha, and `formatHex8` defaults a missing alpha to fully
    // opaque), so compositing it over a surface is a no-op; only `original`
    // can carry the translucency this guards against.
    const minSurfaceContrast = (color: string) =>
      Math.min(
        ...surfaces.map((surface) =>
          wcagContrast(compositeOverSurface(color, surface), surface),
        ),
      );
    const visible = (color: string) => minSurfaceContrast(color) >= 1.3;
    if (visible(original)) continue;
    const source = rgb(parse(original));
    if (!source) continue;
    const channel =
      minSurfaceContrast("#ffffff") > minSurfaceContrast("#000000") ? 1 : 0;
    // Track the best candidate seen in case no step reaches full visibility.
    let bestCandidate = original;
    let bestContrast = minSurfaceContrast(original);
    for (let step = 1; step <= 20; step += 1) {
      const amount = step / 20;
      const candidate = formatHex8({
        mode: "rgb",
        r: source.r + (channel - source.r) * amount,
        g: source.g + (channel - source.g) * amount,
        b: source.b + (channel - source.b) * amount,
      });
      if (visible(candidate)) {
        bestCandidate = candidate;
        break;
      }
      const candidateContrast = minSurfaceContrast(candidate);
      if (candidateContrast > bestContrast) {
        bestCandidate = candidate;
        bestContrast = candidateContrast;
      }
    }
    // Either the step that reached visibility, or - if the loop exhausted
    // without one - the highest-contrast candidate found, as an explicit
    // fallback rather than silently keeping the invisible original.
    overrides[token] = bestCandidate;
  }
  return overrides;
}
