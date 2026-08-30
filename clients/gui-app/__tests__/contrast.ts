/// <reference types="node" />
/**
 * WCAG contrast-ratio calculator for `oklch(...)`/hex color strings, plus a
 * snapshot of `src/index.css`'s per-preset surface tokens. Lets tests assert
 * real contrast ratios against resolved theme colors instead of only
 * checking for a Tailwind class name.
 *
 * The surface tables below mirror `src/index.css` and must be kept in sync
 * with it by hand - accent-only presets (rose/blue/violet/green/orange/pink)
 * are omitted because they inherit the default `:root`/`.dark`
 * background/canvas/popover unchanged.
 *
 * `resolveThemeTokens` at the bottom is the successor to that hand-sync: it
 * parses `src/index.css` and cascades the theme blocks itself, and its preset
 * set is pinned to the app's own `THEME_PRESETS` registry so a preset added to
 * one and not the other fails loudly. Prefer it for new tests. It resolves
 * every custom property `index.css` declares, but only OPAQUE colors are
 * measurable - read them through `themeToken`, which rejects the rest by name
 * (see its docstring).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { THEME_PRESETS } from "@/lib/theme-presets";

export interface ThemeSurfaces {
  readonly background: string;
  readonly canvas: string;
  readonly popover: string;
  /**
   * `--accent`. Carried because selection surfaces wash it over the row and
   * then composite a state tint on top, and most presets keep it a near-grey
   * while `traycer-green` sets it to its saturated `--primary` - the one case
   * that decides whether a tinted glyph survives being selected.
   */
  readonly accent: string;
}

export const LIGHT_THEME_SURFACES: Readonly<Record<string, ThemeSurfaces>> = {
  default: {
    background: "oklch(0.985 0 0)",
    canvas: "oklch(1 0 0)",
    popover: "oklch(1 0 0)",
    accent: "oklch(0.97 0 0)",
  },
  amoled: {
    background: "#fafafa",
    canvas: "#ffffff",
    popover: "#ffffff",
    accent: "#ebebeb",
  },
  "traycer-green": {
    background: "#f6f9f8",
    canvas: "#ffffff",
    popover: "#ffffff",
    accent: "#eaeaea",
  },
  dracula: {
    background: "#efefef",
    canvas: "#f8f8f2",
    popover: "#ffffff",
    accent: "#eaeaee",
  },
  catppuccin: {
    background: "#e6e9ef",
    canvas: "#eff1f5",
    popover: "#e6e9ef",
    accent: "#ccd0da",
  },
  github: {
    background: "#f6f8fa",
    canvas: "#ffffff",
    popover: "#ffffff",
    accent: "#eaeef2",
  },
  gruvbox: {
    background: "#f2e5bc",
    canvas: "#fbf1c7",
    popover: "#f2e5bc",
    accent: "#ebdbb2",
  },
  "tokyo-night": {
    background: "#d0d5e3",
    canvas: "#e1e2e7",
    popover: "#d0d5e3",
    accent: "#b7c1e3",
  },
  nord: {
    background: "#e5e9f0",
    canvas: "#eceff4",
    popover: "#e5e9f0",
    accent: "#d8dee9",
  },
  ayu: {
    background: "#f8f9fa",
    canvas: "#fcfcfc",
    popover: "#f8f9fa",
    accent: "#eef0f3",
  },
  everforest: {
    background: "#f4f0d9",
    canvas: "#fdf6e3",
    popover: "#f4f0d9",
    accent: "#efebd4",
  },
};

export const DARK_THEME_SURFACES: Readonly<Record<string, ThemeSurfaces>> = {
  default: {
    background: "oklch(0.205 0 0)",
    canvas: "oklch(0.145 0 0)",
    popover: "oklch(0.205 0 0)",
    accent: "oklch(0.269 0 0)",
  },
  amoled: {
    background: "#000000",
    canvas: "#000000",
    popover: "#1a1a1a",
    accent: "#1f1f1f",
  },
  "traycer-green": {
    background: "#121715",
    canvas: "#0f0f0f",
    popover: "#1a2421",
    accent: "#257174",
  },
  dracula: {
    background: "#21222c",
    canvas: "#282a36",
    popover: "#343746",
    accent: "#44475a",
  },
  catppuccin: {
    background: "#181825",
    canvas: "#1e1e2e",
    popover: "#313244",
    accent: "#45475a",
  },
  github: {
    background: "#010409",
    canvas: "#0d1117",
    popover: "#161b22",
    accent: "#21262d",
  },
  gruvbox: {
    background: "#1d2021",
    canvas: "#282828",
    popover: "#32302f",
    accent: "#3c3836",
  },
  "tokyo-night": {
    background: "#16161e",
    canvas: "#1a1b26",
    popover: "#24283b",
    accent: "#2a2e41",
  },
  nord: {
    background: "#242933",
    canvas: "#2e3440",
    popover: "#3b4252",
    accent: "#434c5e",
  },
  ayu: {
    background: "#080b10",
    canvas: "#0b0e14",
    popover: "#11151c",
    accent: "#1c222b",
  },
  everforest: {
    background: "#232a2e",
    canvas: "#2d353b",
    popover: "#343f44",
    accent: "#3d484d",
  },
};

// `--muted-foreground` per preset - unlike the surfaces above, presets
// override this alongside their own hue, so light/dark tables must carry
// the actual per-preset value (not the default gray).
export const MUTED_FOREGROUND_LIGHT: Readonly<Record<string, string>> = {
  default: "oklch(0.556 0 0)",
  amoled: "#7d7d7d",
  "traycer-green": "#666666",
  dracula: "#4f5d86",
  catppuccin: "#5c6074",
  github: "#656d76",
  gruvbox: "#665c54",
  "tokyo-night": "#3f528f",
  nord: "#4c566a",
  ayu: "#626a73",
  everforest: "#5f6b62",
};

export const MUTED_FOREGROUND_DARK: Readonly<Record<string, string>> = {
  default: "oklch(0.708 0 0)",
  amoled: "#a0a0a0",
  "traycer-green": "#a8a8a8",
  dracula: "#a1a8c3",
  catppuccin: "#a6adc8",
  github: "#8b949e",
  gruvbox: "#a89984",
  "tokyo-night": "#9aa5ce",
  nord: "#d8dee9",
  ayu: "#828890",
  everforest: "#a4afa7",
};

// `--destructive` and `--success-foreground` are intentionally NOT
// preset-overridden (see index.css) - one value each for light/dark.
export const DESTRUCTIVE_FOREGROUND = {
  light: "oklch(0.577 0.245 27.325)",
  dark: "oklch(0.704 0.191 22.216)",
} as const;

export const SUCCESS_FOREGROUND = {
  light: "oklch(0.42 0.13 145)",
  dark: "oklch(0.75 0.15 145)",
} as const;

function linearChannel(normalized: number): number {
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function hexToLinearSrgb(hex: string): readonly [number, number, number] {
  const normalized = hex.replace("#", "");
  const byteAt = (start: number): number =>
    parseInt(normalized.slice(start, start + 2), 16) / 255;
  return [
    linearChannel(byteAt(0)),
    linearChannel(byteAt(2)),
    linearChannel(byteAt(4)),
  ];
}

// OKLab -> linear sRGB, per the CSS Color 4 / Björn Ottosson reference
// matrices used by browsers to resolve `oklch(...)`.
function oklchToLinearSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): readonly [number, number, number] {
  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function parseColorToLinearSrgb(
  value: string,
): readonly [number, number, number] {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return hexToLinearSrgb(trimmed);
  const match = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(trimmed);
  if (match === null) {
    throw new Error(`Unsupported color for contrast calculation: ${value}`);
  }
  return oklchToLinearSrgb(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
}

function relativeLuminance(
  linearSrgb: readonly [number, number, number],
): number {
  const clamp = (channel: number): number => Math.min(1, Math.max(0, channel));
  const [r, g, b] = linearSrgb;
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/** WCAG 2.x contrast ratio (1:1 to 21:1) between two `oklch(...)`/hex colors. */
export function contrastRatio(foreground: string, background: string): number {
  const fgLuminance = relativeLuminance(parseColorToLinearSrgb(foreground));
  const bgLuminance = relativeLuminance(parseColorToLinearSrgb(background));
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Alpha-composites `foreground` at `alpha` over `background` in sRGB gamma
 * space (matching how browsers paint a translucent CSS background color),
 * returning a hex string usable with `contrastRatio`.
 */
export function compositeOverBackground(
  foreground: string,
  alpha: number,
  background: string,
): string {
  const toSrgbByte = (linear: number): number => {
    const clamped = Math.min(1, Math.max(0, linear));
    const encoded =
      clamped <= 0.0031308
        ? clamped * 12.92
        : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  };
  const mixChannel = (fgLinear: number, bgLinear: number): string => {
    const fgByte = toSrgbByte(fgLinear);
    const bgByte = toSrgbByte(bgLinear);
    const mixedByte = Math.round(fgByte * alpha + bgByte * (1 - alpha));
    return mixedByte.toString(16).padStart(2, "0");
  };
  const [fgR, fgG, fgB] = parseColorToLinearSrgb(foreground);
  const [bgR, bgG, bgB] = parseColorToLinearSrgb(background);
  return `#${mixChannel(fgR, bgR)}${mixChannel(fgG, bgG)}${mixChannel(fgB, bgB)}`;
}

// ---------------------------------------------------------------------------
// Theme resolution straight out of `src/index.css`
// ---------------------------------------------------------------------------

/**
 * Which of the two palettes is on `<html>`. Named after `theme-applier`'s
 * `ResolvedTheme` rather than reusing `ThemeMode`, which the settings store
 * already exports as the THREE-member `"system" | "light" | "dark"`.
 */
export type ResolvedThemeMode = "light" | "dark";

interface ThemeBlock {
  readonly selectors: ReadonlyArray<string>;
  readonly declarations: ReadonlyMap<string, string>;
}

/** `:root`, `.dark`, `[data-theme="x"]`, `.dark[data-theme="x"]` - nothing else. */
const THEME_SELECTOR =
  /^(?::root|\.dark(?:\[data-theme="[^"]+"\])?|\[data-theme="[^"]+"\])$/;

const THEMED_SELECTOR = /\[data-theme="([^"]+)"\]/;

const CUSTOM_PROPERTY = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i;

/** The only color shapes the math below can consume. Shared with `themeToken`. */
const MEASURABLE_COLOR =
  /^(?:#[0-9a-f]{6}|oklch\([\d.]+\s+[\d.]+\s+[\d.]+\))$/i;

let cachedThemeBlocks: ReadonlyArray<ThemeBlock> | null = null;

/**
 * Every rule in `index.css` whose selector list is made only of theme
 * selectors, with the at-rules enclosing it.
 *
 * Brace-depth tracked rather than pattern-matched. The distinction matters
 * because a pattern that merely fails to match a block DROPS it, and every
 * sweep built on this asserts an empty failure list - so a dropped preset
 * makes those tests strictly easier to pass. It is also why this is hand-rolled
 * instead of reaching for postcss: `postcss` is not a declared dependency of
 * the OSS repo (only of the internal monorepo this happens to be nested in),
 * so importing it here passes locally and fails in `traycer`'s own CI.
 */
function parseThemeRules(css: string): ReadonlyArray<{
  readonly selectors: ReadonlyArray<string>;
  readonly body: string;
  readonly atRules: ReadonlyArray<string>;
}> {
  const rules: Array<{
    selectors: ReadonlyArray<string>;
    body: string;
    atRules: ReadonlyArray<string>;
  }> = [];
  const openAtRules: string[] = [];
  let pending = "";
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === "{") {
      const prelude = pending.trim();
      const close = matchingBrace(css, index);
      if (prelude.startsWith("@")) {
        openAtRules.push(prelude.split(/\s+/)[0].slice(1));
        pending = "";
        index += 1;
        continue;
      }
      const selectors = prelude.split(",").map((selector) => selector.trim());
      if (selectors.every((selector) => THEME_SELECTOR.test(selector))) {
        rules.push({
          selectors,
          body: css.slice(index + 1, close),
          atRules: [...openAtRules],
        });
      }
      pending = "";
      index = close + 1;
      continue;
    }
    if (character === "}") {
      openAtRules.pop();
      pending = "";
      index += 1;
      continue;
    }
    pending += character;
    index += 1;
  }
  return rules;
}

/** Index of the `}` closing the `{` at `open`, or the end of the input. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return css.length;
}

function themeBlocks(): ReadonlyArray<ThemeBlock> {
  if (cachedThemeBlocks !== null) return cachedThemeBlocks;
  // Resolved off `process.cwd()` - vitest runs from the project root here. NOT
  // `import.meta.url`: Vite rewrites that to a non-file URL for this module
  // when the importing test lives under `src/**`. A `?raw` import is not an
  // option either - vitest does not process CSS, so it yields "".
  const stylesheet = join(process.cwd(), "src", "index.css");
  // Comments can hold braces and stray selector text; drop them before any
  // structural scanning.
  const css = readFileSync(stylesheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: ThemeBlock[] = [];
  for (const rule of parseThemeRules(css)) {
    const declarations = new Map<string, string>();
    for (const declaration of splitDeclarations(rule.body)) {
      const parsed = CUSTOM_PROPERTY.exec(declaration);
      if (parsed !== null) declarations.set(parsed[1], parsed[2]);
    }
    if (declarations.size === 0) continue;
    // Neither cascade layers nor media/support conditions are modelled by the
    // specificity+order ranking below, so a palette token inside one is
    // refused rather than ranked wrongly. `@layer base`'s `:root` holds only
    // `--traycer-code-*`, which nothing here measures, so it is skipped
    // silently - it is a theme block by selector, not by content.
    if (rule.atRules.length > 0) {
      const measurable = [...declarations].filter(([, value]) =>
        MEASURABLE_COLOR.test(value),
      );
      if (measurable.length > 0) {
        throw new Error(
          `Palette tokens inside @${rule.atRules.join(" > @")} are not modelled here ` +
            `(${rule.selectors.join(", ")} in ${stylesheet}): ` +
            measurable.map(([name]) => name).join(", "),
        );
      }
      continue;
    }
    blocks.push({ selectors: rule.selectors, declarations });
  }
  assertPaletteCoverage(blocks, stylesheet);
  cachedThemeBlocks = blocks;
  return blocks;
}

/** Splits a rule body on `;` at depth 0, so a `;` inside `url(...)` is safe. */
function splitDeclarations(body: string): ReadonlyArray<string> {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (character === ";" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  out.push(current);
  return out;
}

/**
 * The completeness guard. A scanner that silently sees FEWER presets than exist
 * makes every sweep pass more easily, so the derived set is checked against the
 * app's own registry - the one the theme picker offers and `theme-applier`
 * writes to `data-theme`. `THEME_PRESETS` calls the unthemed palette
 * `"neutral"`; this module calls it `"default"`, since it has no `data-theme`
 * block of its own. A dropped `:root`/`.dark` block is caught separately, by
 * `themeToken` throwing on the tokens that would go missing.
 */
function assertPaletteCoverage(
  blocks: ReadonlyArray<ThemeBlock>,
  stylesheet: string,
): void {
  const parsed = new Set<string>();
  for (const block of blocks) {
    for (const selector of block.selectors) {
      const themed = THEMED_SELECTOR.exec(selector);
      if (themed !== null) parsed.add(themed[1]);
    }
  }
  const expected: ReadonlyArray<string> = THEME_PRESETS.map(
    (preset) => preset.id,
  ).filter((id) => id !== "neutral");
  const missing = expected.filter((id) => !parsed.has(id));
  const unexpected = [...parsed].filter((id) => !expected.includes(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Theme presets in ${stylesheet} do not match THEME_PRESETS. ` +
        `Missing from the stylesheet: [${missing.join(", ")}]. ` +
        `Not in the registry: [${unexpected.join(", ")}].`,
    );
  }
}

/** Class-column specificity: these selectors are flat lists of simple parts. */
function selectorSpecificity(selector: string): number {
  return (selector.match(/:root|\.dark|\[data-theme="[^"]+"\]/g) ?? []).length;
}

function selectorApplies(
  selector: string,
  theme: string,
  mode: ResolvedThemeMode,
): boolean {
  // Structural, not `includes(".dark")`: a `:root:not(.dark)` would read as
  // dark-only under a substring test, i.e. exactly backwards.
  if (selector.startsWith(".dark") && mode !== "dark") return false;
  const themed = THEMED_SELECTOR.exec(selector);
  if (themed === null) return true;
  return themed[1] === theme;
}

/**
 * The custom properties in effect on `<html>` for a given preset and mode,
 * cascaded by specificity then source order, later writes winning. `theme` is
 * `"default"` for the unthemed `:root`/`.dark` palette, or a `data-theme`
 * value. Every block reaching this point is unlayered and unconditional -
 * `themeBlocks` refuses a palette token declared inside an at-rule rather than
 * rank it by a model that ignores layer origin and media conditions.
 */
export function resolveThemeTokens(
  theme: string,
  mode: ResolvedThemeMode,
): ReadonlyMap<string, string> {
  const applicable = themeBlocks().flatMap((block, order) => {
    const hits = block.selectors.filter((selector) =>
      selectorApplies(selector, theme, mode),
    );
    if (hits.length === 0) return [];
    return [
      {
        specificity: Math.max(...hits.map(selectorSpecificity)),
        order,
        declarations: block.declarations,
      },
    ];
  });
  applicable.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const resolved = new Map<string, string>();
  for (const entry of applicable) {
    for (const [name, value] of entry.declarations) resolved.set(name, value);
  }
  return resolved;
}

/**
 * Reads a token that must exist AND must be an opaque color the math here can
 * consume. Both halves matter: the resolver returns raw declaration text, so
 * plenty of real tokens are alpha-carrying oklch (`--border`, `--input`),
 * `var()` indirection (`--app-background`), or not colors at all (`--radius`,
 * the font stacks). Failing here names the token; failing inside
 * `parseColorToLinearSrgb` does not - which is why both gates share
 * `MEASURABLE_COLOR` rather than keeping two patterns that can drift.
 */
export function themeToken(
  tokens: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`Theme token ${name} is undefined`);
  if (!MEASURABLE_COLOR.test(value)) {
    throw new Error(
      `Theme token ${name} is not an opaque color this module can measure: ${value}`,
    );
  }
  return value;
}

/**
 * `"default"` plus every `data-theme` value `index.css` defines. Derived, and
 * `assertPaletteCoverage` pins it to the app's own registry, so a preset added
 * to both is swept by existing tests without touching this file - and one
 * added to only one of them fails loudly.
 */
export function themePresets(): ReadonlyArray<string> {
  const presets = new Set<string>(["default"]);
  for (const block of themeBlocks()) {
    for (const selector of block.selectors) {
      const themed = THEMED_SELECTOR.exec(selector);
      if (themed !== null) presets.add(themed[1]);
    }
  }
  return [...presets];
}

/**
 * A full-palette preset repaints the surfaces; an accent-only one
 * (rose/blue/violet/green/orange/pink) overrides `--primary` and friends on
 * top of the default light/dark palette.
 *
 * Decided on the RESOLVED `--background` for the mode asked about, not on
 * which block happens to declare one: a preset that repaints surfaces in light
 * only shares the default `--background` in dark, and inspecting blocks would
 * call it full-palette in both (a bare `[data-theme="x"]` selector applies in
 * either mode).
 */
export function isFullPalettePreset(
  theme: string,
  mode: ResolvedThemeMode,
): boolean {
  if (theme === "default") return true;
  return (
    resolveThemeTokens(theme, mode).get("--background") !==
    resolveThemeTokens("default", mode).get("--background")
  );
}
