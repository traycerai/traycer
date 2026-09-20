/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatHex8, parse, rgb, wcagContrast } from "culori";
import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "@/lib/theme-presets";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import { isThemeToken, type ThemeToken } from "@/lib/themes/theme-definition";

/**
 * Contrast matrix for the Customize editor: every built-in preset in both
 * modes, measured against the editor's REAL stylesheet.
 *
 * The values that matter (outline colours, the ghost/drop-target alpha, which
 * tokens the control scope remaps) are read out of `customize.css` instead of
 * being copied here, so the matrix re-measures whatever ships. A rule that
 * stops parsing throws, so the test never silently measures the unscoped
 * theme. Pairs the CSS does not touch are modelled from the component classes
 * they come from (each constant below names its source).
 *
 * culori's `wcagContrast` ignores alpha, so every translucent fill - including
 * theme tokens that carry their own alpha (`--input`, `--border`) - is
 * composited over the surface it lands on first (see `theme-definition.ts`).
 *
 * Limits: built-in presets only (imported themes are user data), a single
 * opaque surface per token (no glass/transparency), no forced-colors.
 */

type Palette = Partial<Record<ThemeToken, string>>;
type Mode = "light" | "dark";

/** Surfaces a proxy, ghost or drop indicator can sit on top of. */
const SURFACES: ReadonlyArray<ThemeToken> = [
  "background",
  "canvas",
  "card",
  "popover",
  "sidebar",
];
/** WCAG 1.4.3 (text) and 1.4.11 (UI components / focus indicators). */
const TEXT = 4.5;
const NON_TEXT = 3;
/** `customize-scrim.tsx`: the dim layer is `fill-black` at this opacity. */
const SCRIM_OPACITY = 0.35;
/** `ui/input`: `dark:bg-input/30`; `ui/button` outline: `dark:bg-input/30`. */
const DARK_FIELD_FILL = 0.3;

interface Case {
  readonly label: string;
  readonly mode: Mode;
  readonly palette: Palette;
}

const CASES: ReadonlyArray<Case> = THEME_PRESETS.flatMap((preset) =>
  (["light", "dark"] as const).map((mode) => ({
    label: `${preset.id}/${mode}`,
    mode,
    palette: getBuiltinThemeColors(preset.id, mode),
  })),
);

function resolveFrom(
  palette: Palette,
  token: ThemeToken,
  depth: number,
): string {
  const value = palette[token];
  if (value === undefined || depth > 8)
    throw new Error(`token --${token} does not resolve`);
  const reference = /^var\(--([a-z-]+)\)$/.exec(value)?.[1];
  if (reference === undefined) return value;
  if (!isThemeToken(reference))
    throw new Error(`--${token} references unknown --${reference}`);
  return resolveFrom(palette, reference, depth + 1);
}
/** Follows `var(--token)` chains the way the cascade would. */
const resolve = (palette: Palette, token: ThemeToken): string =>
  resolveFrom(palette, token, 0);

/**
 * `foreground` at `alpha`, over `surface` - opaque hex out. The colour's own
 * alpha (`oklch(1 0 0 / 15%)`) multiplies in, so `input` at `/30` on top of a
 * 15%-alpha token is 4.5%, as the browser paints it.
 */
function composite(foreground: string, surface: string, alpha: number): string {
  const top = rgb(parse(foreground));
  const bottom = rgb(parse(surface));
  if (top === undefined || bottom === undefined)
    throw new Error(`cannot composite ${foreground} over ${surface}`);
  const coverage = (top.alpha ?? 1) * alpha;
  return formatHex8({
    mode: "rgb",
    r: top.r * coverage + bottom.r * (1 - coverage),
    g: top.g * coverage + bottom.g * (1 - coverage),
    b: top.b * coverage + bottom.b * (1 - coverage),
  });
}

const dimmed = (surface: string): string =>
  composite("#000000", surface, SCRIM_OPACITY);

// --- the real stylesheet ----------------------------------------------------

const RULES = [
  ...readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "customize.css",
    ),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((match) => ({ selector: match[1].trim(), body: match[2] }));

/** Value of `property` in the first rule whose selector satisfies `matches`. */
function cssValue(
  matches: (selector: string) => boolean,
  property: string,
): string {
  for (const rule of RULES) {
    if (!matches(rule.selector)) continue;
    const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`)
      .exec(rule.body)?.[1]
      ?.trim();
    if (value !== undefined) return value;
  }
  throw new Error(`customize.css: no ${property} for the expected rule`);
}

function themeToken(value: string): ThemeToken {
  const name = /^var\(--([a-z-]+)\)$/.exec(value)?.[1];
  if (name === undefined || !isThemeToken(name))
    throw new Error(`customize.css: ${value} is not a theme var()`);
  return name;
}

const OUTLINE: Readonly<Record<Mode, string>> = {
  light: cssValue(
    (s) => s === "[data-customize-editor]",
    "--customize-outline",
  ),
  dark: cssValue(
    (s) => s === ".dark [data-customize-editor]",
    "--customize-outline",
  ),
};
/** `color-mix(in srgb, var(--customize-outline) 80%, transparent)` -> 0.8. */
const GHOST_ALPHA =
  Number(
    /(\d+)%/.exec(
      cssValue((s) => s.includes("[data-customize-ghost]"), "border-color"),
    )?.[1],
  ) / 100;
/** `customize-search.tsx`: the highlighted result is `bg-foreground/N`. */
const ACTIVE_RESULT_WASH =
  Number(
    /index === search\.activeIndex && "bg-foreground\/(\d+)"/.exec(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "customize-search.tsx",
        ),
        "utf8",
      ),
    )?.[1],
  ) / 100;
/** An open (aria-expanded) editor button: `color-mix(... foreground N% ...)`. */
const EXPANDED_WASH =
  Number(
    /(\d+)%/.exec(
      cssValue((s) => s.includes('[aria-expanded="true"]'), "background-color"),
    )?.[1],
  ) / 100;
/** The remaps the control scope applies (`--primary: var(--foreground)`, ...). */
const SCOPE = new Map<ThemeToken, ThemeToken>();
for (const pair of (
  RULES.find((rule) => rule.body.includes("--primary:"))?.body ?? ""
).matchAll(/--([a-z-]+):\s*(var\(--[a-z-]+\))\s*;/g)) {
  const target = pair[1];
  if (isThemeToken(target)) SCOPE.set(target, themeToken(pair[2]));
}
const CONTROL_BORDER = themeToken(
  cssValue((s) => s.includes('[data-slot="switch"]'), "border-color"),
);
const MUTED_TEXT = themeToken(
  cssValue((s) => s.includes(".text-muted-foreground"), "color"),
);
const FOCUS_OUTLINE = themeToken(
  /(var\(--[a-z-]+\))/.exec(
    cssValue(
      (s) => s.endsWith(":focus-visible") && s.includes(":is(button"),
      "outline",
    ),
  )?.[1] ?? "",
);

/**
 * The focused menu item (portalled dropdown rows): an INSET outline, so it is
 * drawn over the item's own `focus:bg-accent` fill with the menu's popover
 * surface just outside it.
 */
const isMenuItemFocus = (selector: string): boolean =>
  selector.includes("menuitem") && selector.endsWith(":focus");
const MENU_ITEM_OUTLINE_VALUE = cssValue(isMenuItemFocus, "outline");
const MENU_ITEM_OUTLINE = themeToken(
  /(var\(--[a-z-]+\))/.exec(MENU_ITEM_OUTLINE_VALUE)?.[1] ?? "",
);
const MENU_ITEM_OUTLINE_OFFSET = cssValue(isMenuItemFocus, "outline-offset");

/** A theme token as seen from inside an editor control (scope applied). */
const inControl = (testCase: Case, token: ThemeToken): string =>
  resolve(testCase.palette, SCOPE.get(token) ?? token);

// --- measuring --------------------------------------------------------------

type Need = (name: string, fg: string, bg: string, minimum: number) => void;

/** Runs `check` for every preset/mode and returns EVERY violated pair. */
function violations(check: (testCase: Case, need: Need) => void): string[] {
  const failed: string[] = [];
  for (const testCase of CASES)
    check(testCase, (name, fg, bg, minimum) => {
      const ratio = wcagContrast(fg, bg);
      if (ratio < minimum)
        failed.push(
          `${testCase.label} ${name}: ${ratio.toFixed(2)} < ${minimum}`,
        );
    });
  return failed;
}

/** Each surface, plain (a cut-out hole) and under the scrim. */
function onSurfaces(
  testCase: Case,
  need: Need,
  name: string,
  paint: (surface: string) => string,
): void {
  for (const token of SURFACES) {
    const surface = resolve(testCase.palette, token);
    need(`${name} on ${token}`, paint(surface), surface, NON_TEXT);
    need(
      `${name} on dimmed ${token}`,
      paint(dimmed(surface)),
      dimmed(surface),
      NON_TEXT,
    );
  }
}

describe("customize.css is read, not assumed", () => {
  it("yields the control scope, outlines and alphas the matrix measures", () => {
    expect(OUTLINE.light).not.toBe(OUTLINE.dark);
    expect(GHOST_ALPHA).toBeGreaterThan(0);
    expect(GHOST_ALPHA).toBeLessThanOrEqual(1);
    expect(MENU_ITEM_OUTLINE_VALUE).toMatch(/^2px solid /);
    expect(MENU_ITEM_OUTLINE_OFFSET).toBe("-2px");
    expect(ACTIVE_RESULT_WASH).toBeGreaterThan(0);
    expect(EXPANDED_WASH).toBeGreaterThan(0);
    for (const token of ["primary", "primary-foreground", "ring"] as const)
      expect(SCOPE.has(token)).toBe(true);
    // The scope must not reach inert option pictures.
    expect(
      RULES.find((rule) => rule.body.includes("--primary:"))?.selector,
    ).toContain(":not([inert] *)");
  });
});

describe("Customize editor contrast across built-in palettes", () => {
  it("solid proxy outline, active ring, drop line and active drop target hold 3:1, plain and scrim-dimmed", () => {
    expect(
      violations((testCase, need) =>
        onSurfaces(testCase, need, "outline", () => OUTLINE[testCase.mode]),
      ),
    ).toEqual([]);
  });

  it("ghost and idle drop-target borders (translucent stroke) hold 3:1 over the dimmed page", () => {
    expect(
      violations((testCase, need) =>
        onSurfaces(testCase, need, "ghost border", (surface) =>
          composite(OUTLINE[testCase.mode], surface, GHOST_ALPHA),
        ),
      ),
    ).toEqual([]);
  });

  it("body and muted text on the popover, the active search result and an open button hold 4.5:1", () => {
    expect(
      violations((testCase, need) => {
        const popover = resolve(testCase.palette, "popover");
        const foreground = resolve(testCase.palette, "foreground");
        const body = resolve(testCase.palette, "popover-foreground");
        const muted = resolve(testCase.palette, MUTED_TEXT);
        const grounds = {
          popover,
          "active result": composite(foreground, popover, ACTIVE_RESULT_WASH),
          "open button": composite(foreground, popover, EXPANDED_WASH),
        };
        for (const [name, ground] of Object.entries(grounds)) {
          need(`body on ${name}`, body, ground, TEXT);
          need(`muted on ${name}`, muted, ground, TEXT);
        }
      }),
    ).toEqual([]);
  });

  it("primary button label holds 4.5:1 on its scoped fill", () => {
    expect(
      violations((testCase, need) =>
        need(
          "label on primary",
          inControl(testCase, "primary-foreground"),
          inControl(testCase, "primary"),
          TEXT,
        ),
      ),
    ).toEqual([]);
  });

  it("control borders and the focus outline hold 3:1 against the popover", () => {
    expect(
      violations((testCase, need) => {
        const popover = resolve(testCase.palette, "popover");
        need(
          "border",
          resolve(testCase.palette, CONTROL_BORDER),
          popover,
          NON_TEXT,
        );
        need(
          "focus outline",
          resolve(testCase.palette, FOCUS_OUTLINE),
          popover,
          NON_TEXT,
        );
      }),
    ).toEqual([]);
  });

  it("the focused menu item's inset outline holds 3:1 against both the popover edge and the focused accent fill", () => {
    expect(
      violations((testCase, need) => {
        const outline = resolve(testCase.palette, MENU_ITEM_OUTLINE);
        const popover = resolve(testCase.palette, "popover");
        // `ui/dropdown-menu` item: `focus:bg-accent`. The token may carry
        // its own alpha, so composite it over the menu surface it lands on.
        const accent = composite(
          resolve(testCase.palette, "accent"),
          popover,
          1,
        );
        need("menu item outline on popover", outline, popover, NON_TEXT);
        need("menu item outline on focused accent", outline, accent, NON_TEXT);
      }),
    ).toEqual([]);
  });

  it("input text and placeholder hold 4.5:1 on the real field fill", () => {
    expect(
      violations((testCase, need) => {
        const popover = resolve(testCase.palette, "popover");
        // `ui/input`: transparent in light, `dark:bg-input/30` in dark.
        const fill =
          testCase.mode === "dark"
            ? composite(
                resolve(testCase.palette, "input"),
                popover,
                DARK_FIELD_FILL,
              )
            : popover;
        need(
          "input text",
          resolve(testCase.palette, "popover-foreground"),
          fill,
          TEXT,
        );
        need(
          "placeholder",
          inControl(testCase, "muted-foreground"),
          fill,
          TEXT,
        );
      }),
    ).toEqual([]);
  });

  it("outline-variant button text holds 4.5:1 at rest and on hover", () => {
    expect(
      violations((testCase, need) => {
        const popover = resolve(testCase.palette, "popover");
        const foreground = resolve(testCase.palette, "foreground");
        const input = resolve(testCase.palette, "input");
        const dark = testCase.mode === "dark";
        // `ui/button` outline: `bg-background hover:bg-foreground/5`, and in
        // dark `dark:bg-input/30 dark:hover:bg-input/50`.
        const rest = dark
          ? composite(input, popover, DARK_FIELD_FILL)
          : resolve(testCase.palette, "background");
        const hover = dark
          ? composite(input, popover, 0.5)
          : composite(foreground, rest, 0.05);
        need(
          "label at rest",
          resolve(testCase.palette, "popover-foreground"),
          rest,
          TEXT,
        );
        need("label on hover", foreground, hover, TEXT);
      }),
    ).toEqual([]);
  });

  it("the checked switch thumb holds 3:1 on its filled track", () => {
    expect(
      violations((testCase, need) =>
        // `ui/switch`: checked track `bg-primary`; thumb `bg-background`
        // (dark: `bg-primary-foreground`, which the scope remaps to
        // `background`). The unchecked boundary is the explicit control
        // border asserted above, not a fill ratio.
        need(
          "thumb on checked track",
          testCase.mode === "dark"
            ? inControl(testCase, "primary-foreground")
            : resolve(testCase.palette, "background"),
          inControl(testCase, "primary"),
          NON_TEXT,
        ),
      ),
    ).toEqual([]);
  });
});
