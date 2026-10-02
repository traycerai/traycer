/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  compositeOverBackground,
  contrastRatio,
  resolveThemeTokens,
  themePresets,
  themeToken,
  type ResolvedThemeMode,
} from "@/../__tests__/contrast";
import {
  HeaderTabVisual,
  TabChrome,
} from "@/components/layout/tabs/header-tab-visual";
import { sampleWorkspaceTabModule } from "@/stores/tabs/kinds/sample-workspace";
import { tabAppearance } from "@/stores/tabs/types";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

afterEach(cleanup);

/**
 * The layout editor's decoration, measured against every built-in palette in
 * both modes - Amoled included, which is the one that catches a treatment
 * that only works on a mid-grey.
 *
 * Every colour, alpha and opacity below is READ OUT of `layout-editor.css`
 * and every token out of the palette registry, so this matrix re-measures
 * whatever ships rather than a copy of it. A rule that stops parsing throws,
 * which is what keeps a renamed selector from quietly turning the matrix into
 * a measurement of nothing.
 *
 * The bars are WCAG's, applied to what each thing IS. 4.5:1 for anything with
 * words in it - the name chip, the inspector's body and secondary text. 3:1
 * for an INDICATOR, which is the hover outline and the travelling ring: those
 * are the only things that say "this is the element you are editing", so they
 * answer to 1.4.11. (The static outline on a selected region's OTHER instances
 * was a third, until L-87 left every region with exactly one - see
 * `layout-editor.css`.)
 *
 * The passive dim and a materialised ghost do NOT. Both are deliberately
 * faint, and 1.4.11 exempts a component that is not available for
 * interaction - the canvas is behind the edit firewall and a ghost is a
 * preview of a region that is switched OFF. Inventing a ratio for them would
 * be inventing the design. What they are held to instead is relational, and
 * both relations are real: a dim has to be visibly a dim in every palette
 * (the treatment it replaced, a 35% black scrim, satisfied every ratio here
 * and was invisible on Amoled), and a ghost must never read quieter than the
 * calm chrome it appears among.
 */

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function read(relativePath: string): string {
  return readFileSync(path.join(SRC_DIR, relativePath), "utf8");
}

const CSS_FILE = path.join(
  SRC_DIR,
  "components",
  "layout-editor",
  "layout-editor.css",
);

const TEXT = 4.5;
const NON_TEXT = 3;

/** Every surface the editor's decoration can land on. */
const SURFACES = ["background", "canvas", "card", "popover", "sidebar"];

// --- the real stylesheet ----------------------------------------------------

interface CssRule {
  /** The `@media` prelude this rule sits under, or `""` at the top level. */
  readonly context: string;
  readonly selector: string;
  readonly body: string;
}

/**
 * Brace-depth parse rather than a flat regex: the fallbacks that matter here
 * live INSIDE `@media` blocks and restate a selector the top level already
 * has, so a parser that cannot tell the two apart would measure the wrong one.
 */
function parseCss(css: string): ReadonlyArray<CssRule> {
  const rules: CssRule[] = [];
  const open: string[] = [];
  let buffer = "";
  for (const character of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (character === "{") {
      open.push(buffer.trim());
      buffer = "";
      continue;
    }
    if (character === "}") {
      const prelude = open.pop() ?? "";
      if (!prelude.startsWith("@")) {
        rules.push({
          context: open.filter((entry) => entry.startsWith("@")).join(" "),
          selector: prelude.replace(/\s+/g, " "),
          body: buffer,
        });
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }
  return rules;
}

const CSS_SOURCE = readFileSync(CSS_FILE, "utf8");
const RULES = parseCss(CSS_SOURCE);

/** The value of `property` in the first rule the predicate accepts. */
function cssValue(
  matches: (rule: CssRule) => boolean,
  property: string,
): string {
  for (const rule of RULES) {
    if (!matches(rule)) continue;
    const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`)
      .exec(rule.body)?.[1]
      ?.trim();
    if (value !== undefined) return value;
  }
  throw new Error(`layout-editor.css: no ${property} for the expected rule`);
}

const topLevel =
  (test: (selector: string) => boolean) =>
  (rule: CssRule): boolean =>
    rule.context === "" && test(rule.selector);

const under =
  (query: string, test: (selector: string) => boolean) =>
  (rule: CssRule): boolean =>
    rule.context.includes(query) && test(rule.selector);

/** `var(--token)` -> `--token`, rejecting anything else by name. */
function tokenName(value: string): string {
  const name = /var\((--[a-z-]+)\)/.exec(value)?.[1];
  if (name === undefined) {
    throw new Error(`layout-editor.css: ${value} is not a theme var()`);
  }
  return name;
}

/**
 * Every SOLID band in a `box-shadow`, by token.
 *
 * A band inside a `color-mix(...)` is translucent and carries no guarantee of
 * its own, so it is left out: what the ring owes is that at least one of the
 * bands a user actually sees clears the indicator floor.
 */
function solidShadowTokens(shadow: string): ReadonlyArray<string> {
  return shadow
    .replace(/color-mix\((?:[^()]|\([^()]*\))*\)/g, "")
    .split(",")
    .flatMap((band) => {
      const name = /var\((--[a-z-]+)\)/.exec(band)?.[1];
      return name === undefined ? [] : [name];
    });
}

/** `color-mix(in srgb, <color> N%, transparent)` -> N/100. */
function mixAlpha(value: string): number {
  const percent = /(\d+(?:\.\d+)?)%/.exec(value)?.[1];
  if (percent === undefined) {
    throw new Error(`layout-editor.css: ${value} carries no percentage`);
  }
  return Number(percent) / 100;
}

const HOVER_OUTLINE = tokenName(
  cssValue(
    topLevel((selector) => selector.includes('[data-hover="1"]')),
    "outline",
  ),
);
const RING_SHADOW = cssValue(
  topLevel((selector) => selector === "[data-layout-selection-ring]"),
  "box-shadow",
);
const RING_BANDS = solidShadowTokens(RING_SHADOW);
const RING_HALO_ALPHA = mixAlpha(RING_SHADOW);
const CHIP_FILL = tokenName(
  cssValue(
    topLevel((selector) => selector === "[data-layout-hover-chip]"),
    "background",
  ),
);
const CHIP_TEXT = tokenName(
  cssValue(
    topLevel((selector) => selector === "[data-layout-hover-chip]"),
    "color",
  ),
);
const GHOST_OPACITY = Number(
  cssValue(
    topLevel((selector) => selector.includes('[data-ghost="1"]')),
    "opacity",
  ),
);
const DIM_RULE = RULES.find(
  (rule) =>
    rule.context === "" &&
    rule.selector.includes("[data-layout-passive]") &&
    rule.body.includes("opacity:"),
);
const DIM_OPACITY = Number(
  cssValue(
    topLevel((selector) => selector.includes("[data-layout-passive]")),
    "opacity",
  ),
);
const FLOAT_MATERIAL = cssValue(
  topLevel(
    (selector) =>
      selector === '[data-layout-inspector][data-dock-mode="float"]',
  ),
  "background",
);
const FLOAT_SURFACE = tokenName(FLOAT_MATERIAL);
const FLOAT_ALPHA = mixAlpha(FLOAT_MATERIAL);
const FLOAT_OPAQUE = tokenName(
  cssValue(
    under("prefers-reduced-transparency", (selector) =>
      selector.includes('[data-dock-mode="float"]'),
    ),
    "background",
  ),
);
const INSPECTOR_SURFACE = tokenName(
  cssValue(
    topLevel((selector) => selector === "[data-layout-inspector]"),
    "background",
  ),
);
const EDITING_FRAME_RULE = RULES.find(
  (rule) =>
    rule.context === "" && rule.selector.includes("[data-layout-column]"),
);

/** A declaration of the frame drawn around the app column while editing. */
function editingFrame(property: string): string {
  return cssValue(
    topLevel((selector) => selector.includes("[data-layout-column]")),
    property,
  );
}

const EDITING_FRAME_COLOR = tokenName(editingFrame("border"));

/** The value of a custom property declared on `:root`. */
function rootValue(name: string): string {
  return cssValue(
    topLevel((selector) => selector === ":root"),
    name,
  );
}

/**
 * Everything the app column draws, so the frame's layer can be measured
 * against the ceiling its comment CLAIMS rather than against one file (R3-10).
 *
 * The column is `app-shell.tsx`'s `[data-layout-column]`: the header, the tab
 * strip and the screen. So these are the header's and the strip's own
 * directories plus the four screen subtrees - not the whole of
 * `components/layout`, whose `dialogs/` and `bridges/` are app-level modals and
 * viewport chrome drawn OUTSIDE the column, which is exactly why they sit at 60
 * and 70.
 */
const COLUMN_DIRS: ReadonlyArray<string> = [
  "components/layout/header",
  "components/layout/tabs",
  "components/epic-canvas",
  "components/chat",
  "components/home",
  "components/sample-workspace",
];

/**
 * The one layer inside the column that is ABOVE the frame, excluded by name.
 *
 * `epic-shell.tsx:119` is an `absolute inset-0 z-50` repoint-failure card,
 * inside the column and therefore over the frame's border. It is 70% opaque and
 * appears only in an error state the sample workspace cannot reach, so it is
 * recorded as the deliberate exception here and in the stylesheet's own comment
 * rather than moved.
 */
const IN_COLUMN_EXCEPTION = "components/epic-canvas/epic-shell.tsx";

/** Every `.tsx` under `directory`, tests excluded. */
function sourceFiles(directory: string): ReadonlyArray<string> {
  return readdirSync(path.join(SRC_DIR, directory), { recursive: true })
    .map((entry) => `${directory}/${String(entry)}`)
    .filter(
      (file) =>
        file.endsWith(".tsx") &&
        !file.includes("__tests__") &&
        !file.includes(".test."),
    );
}

/**
 * The highest stacking layer the app column itself draws.
 *
 * Scanned rather than restated, because the claim being guarded is about the
 * whole column: the old bar was `app-header.tsx` alone, which the frame cleared
 * at 21 and which would not have noticed the canvas climbing to 42.
 *
 * A file that calls `createPortal` is SKIPPED, with the reason that its
 * overlay is not in the column at all - the floating popovers under `chat/`
 * and `epic-canvas/` portal to `body` and sit at 50 there, above the frame and
 * correctly so, exactly as every `components/ui` overlay does. The rule is
 * derived from the source rather than kept as a list, so a new popover is
 * exempt by portalling.
 *
 * The exemption is per FILE, and saying so is the honest half of the claim
 * (R4B-10): a `z-50` this file adds to something it does NOT portal is skipped
 * with the rest, so the scan is a floor on the column's ceiling rather than a
 * proof of it. Per CALL was tried and does not work in this tree - every
 * portalling file here hoists the portalled tree into a variable
 * (`createPortal(menu, document.body)`, `createPortal(inputRow, headerSlot)`),
 * so the classNames are nowhere near the call and only a real JSX parse could
 * tell the two apart. Today the gap is empty: each exempted file's `z-` class
 * belongs to its portalled surface, checked by reading them.
 */
const COLUMN_LAYER = (() => {
  const layers = COLUMN_DIRS.flatMap(sourceFiles).flatMap((file) => {
    if (file === IN_COLUMN_EXCEPTION) return [];
    const source = read(file);
    if (source.includes("createPortal")) return [];
    return [...source.matchAll(/(?:^|[\s:"'])z-(\d+)/g)].map((match) =>
      Number(match[1]),
    );
  });
  if (layers.length === 0) {
    throw new Error("the app column has no stacking layer to measure");
  }
  // The editor's own in-column layer: a region in hand, lifted on the canvas.
  // It lives in the stylesheet rather than in a className, so the scan above
  // cannot see it.
  const inHand = Number(
    cssValue(
      topLevel((selector) => selector === '[data-layout-dragging="1"]'),
      "z-index",
    ),
  );
  return Math.max(...layers, inHand);
})();

/**
 * The amber cap the sample tab ships, read out of the tab kind itself.
 *
 * The tab's colour is a TSX field and the outline is CSS, and they are one
 * signal: a reader who sees an amber tab and a differently-coloured screen
 * outline learns nothing from either. Read rather than restated, so a change
 * to one of them fails here instead of drifting.
 */
const SAMPLE_TAB_COLOR = (() => {
  const source = read("stores/tabs/kinds/sample-workspace.tsx");
  const value = /appearance:\s*\{\s*color:\s*"([^"]+)"/.exec(source)?.[1];
  if (value === undefined) {
    throw new Error("sample-workspace.tsx: no appearance colour to measure");
  }
  return tokenName(value);
})();

const CLEAN_INDICATOR_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

const SESSION_TAB = sampleWorkspaceTabModule.build(null);

/** `HeaderTabVisual` props for the editor's own tab, active or at rest. */
function sessionTabVisualProps(isActive: boolean) {
  return {
    tab: SESSION_TAB,
    appearance: tabAppearance(SESSION_TAB),
    indicatorState: CLEAN_INDICATOR_STATE,
    displayName: SESSION_TAB.name,
    chrome: "own" as const,
    isActive,
    joined: isActive,
    concealed: false,
    titleControl: null,
    trailingControl: null,
    leaderVisible: false,
    enabled: true,
    pairPreview: null,
  };
}

/**
 * The colour the active session tab's LABEL is set in, read off the component
 * that sets it (L-163).
 *
 * The tab's fill is `SAMPLE_TAB_COLOR` at full strength, so the label is text
 * on a coloured surface and owes 4.5:1 on it - the stricter bar, and one no
 * dilution of that token could meet on every palette, which is why there is no
 * share left to tune. Read rather than restated: a label colour changed in the
 * component without a thought for the fill fails here.
 */
const SESSION_TAB_LABEL = (() => {
  const source = read("components/layout/tabs/header-tab-visual.tsx");
  const value = /SESSION_TAB_LABEL_CLASS\s*=\s*"text-([a-z-]+)"/.exec(
    source,
  )?.[1];
  if (value === undefined) {
    throw new Error("header-tab-visual.tsx: no session tab label class");
  }
  return `--${value}`;
})();

// --- measuring --------------------------------------------------------------

interface Palette {
  readonly label: string;
  readonly tokens: ReadonlyMap<string, string>;
}

const PALETTES: ReadonlyArray<Palette> = themePresets().flatMap((preset) =>
  (["light", "dark"] as const).map((mode: ResolvedThemeMode) => ({
    label: `${preset}/${mode}`,
    tokens: resolveThemeTokens(preset, mode),
  })),
);

type Need = (name: string, fg: string, bg: string, minimum: number) => void;

/** Runs `check` for every palette and returns EVERY violated pair. */
function violations(check: (palette: Palette, need: Need) => void): string[] {
  const failed: string[] = [];
  for (const palette of PALETTES) {
    check(palette, (name, fg, bg, minimum) => {
      const ratio = contrastRatio(fg, bg);
      if (ratio < minimum) {
        failed.push(
          `${palette.label} ${name}: ${ratio.toFixed(2)} < ${minimum}`,
        );
      }
    });
  }
  return failed;
}

/** One indicator, measured on every surface it can be drawn over. */
function onSurfaces(
  palette: Palette,
  need: Need,
  name: string,
  paint: (surface: string) => string,
): void {
  for (const surface of SURFACES) {
    const ground = themeToken(palette.tokens, `--${surface}`);
    need(`${name} on ${surface}`, paint(ground), ground, NON_TEXT);
  }
}

describe("layout-editor.css is read, not assumed", () => {
  it("yields the tokens, alphas and opacities the matrix measures", () => {
    expect(RING_BANDS).toContain("--ring");
    expect(RING_HALO_ALPHA).toBeGreaterThan(0);
    expect(RING_HALO_ALPHA).toBeLessThan(1);
    expect(GHOST_OPACITY).toBeGreaterThan(0);
    expect(GHOST_OPACITY).toBeLessThan(1);
    expect(DIM_OPACITY).toBeGreaterThan(0);
    expect(DIM_OPACITY).toBeLessThan(1);
    expect(FLOAT_ALPHA).toBeGreaterThan(0);
    expect(FLOAT_ALPHA).toBeLessThan(1);
    expect(FLOAT_SURFACE).toBe(FLOAT_OPAQUE);
  });

  /**
   * The frame is an OVERLAY on the column, not the column's own `outline`
   * (L-130). An outline painted with the column's own content goes under every
   * positioned descendant that paints an opaque background - measured live,
   * that left 5% of it lit and the rest invisible (LV2-04) - and an OUTSET one
   * on a `h-safe-dvh` column is clipped by the window edge on three sides.
   * Inside the box, above the descendants, and never in the pointer's way,
   * because the canvas under it is what the user points at.
   */
  it("draws the editing frame over the column's children rather than under them", () => {
    expect(EDITING_FRAME_RULE?.selector).toBe(
      '[data-layout-column][data-layout-editing="1"]::after',
    );
    expect(editingFrame("position")).toBe("absolute");
    expect(editingFrame("pointer-events")).toBe("none");
    // The bar is the column's own ceiling, not the header's. The floor under it
    // is what says the scan measured something: the canvas's positioned chrome
    // (the minimap, the PiP, the diff header, the composer shell) sits at 40,
    // so a scan that quietly matched nothing fails here rather than passing.
    expect(COLUMN_LAYER).toBeGreaterThanOrEqual(40);
    const frameLayer = Number(rootValue(tokenName(editingFrame("z-index"))));
    expect(frameLayer).toBeGreaterThan(COLUMN_LAYER);
  });

  /**
   * The one thing above the frame inside the column, kept honest.
   *
   * The exception is excluded by NAME, so it has to keep being what the reason
   * says it is: an overlay that is translucent (a hard fill would hide the
   * canvas rather than dim it) and that only an error state reaches. If it ever
   * becomes something else, this is where that shows up instead of in a
   * screenshot.
   */
  it("names the one in-column overlay that paints over the frame", () => {
    const shell = read(IN_COLUMN_EXCEPTION);
    expect(shell).toContain("absolute inset-0 z-50");
    expect(shell).toContain("bg-background/70");
    // Said where the number is, so a reader of the stylesheet learns it too.
    expect(CSS_SOURCE).toContain("epic-canvas/epic-shell.tsx");
  });

  /**
   * The frame clears the WINDOW's rounded corners (L-137).
   *
   * At `inset: 0` with square corners it ran into the macOS window corner and
   * was sliced off at the top-left and bottom-left - the two corners of the
   * column that ARE window corners while the inspector is docked right.
   *
   * The geometry is one pair of numbers on `:root` rather than a platform
   * branch, because Electron does not expose the OS window radius. An inset
   * rounded rect with radius `r` at inset `i` lies strictly inside a window
   * whose corner radius is `R` whenever `r + i >= R`, so what this measures is
   * that the pair clears a window corner comfortably larger than the ~10pt
   * macOS draws - with room for an OS that grows it - and that the numbers are
   * UNIFORM, which is what makes the frame follow the column in all three dock
   * modes and on a square-cornered platform with no rule of its own.
   */
  it("insets and rounds the editing frame clear of the window's corners", () => {
    const inset = rootValue(tokenName(editingFrame("inset")));
    const radius = rootValue(tokenName(editingFrame("border-radius")));
    const px = (value: string): number => {
      const measured = /^(\d+(?:\.\d+)?)px$/.exec(value.trim())?.[1];
      if (measured === undefined) {
        throw new Error(`the editing frame's geometry is not in px: ${value}`);
      }
      return Number(measured);
    };
    expect(px(inset)).toBeGreaterThan(0);
    expect(px(radius)).toBeGreaterThan(0);
    // The macOS corner measured off the owner's screenshot is ~10pt; clearing
    // 16 leaves the margin an OS bump would eat.
    expect(px(inset) + px(radius)).toBeGreaterThanOrEqual(16);
    // Uniform: one `inset` and one `border-radius`, not four of either. A mix
    // of square and round corners would need to know which corners are the
    // window's, which is the platform fact this design refuses to guess.
    expect(inset.trim().split(/\s+/)).toHaveLength(1);
    expect(radius.trim().split(/\s+/)).toHaveLength(1);
  });

  /**
   * One signal, one token (L-138): the frame is the hollow amber outline
   * around the screen and the editor's own tab is the solid amber object
   * inside it, and a reader who sees an amber tab and a differently-coloured
   * screen outline learns nothing from either.
   *
   * The tab's fill is the colour it is HANDED rather than a value of its own,
   * so the two cannot drift: `TabChrome` passes `props.color` through when the
   * tab is the session's, which is the same field this file reads for
   * `SAMPLE_TAB_COLOR`. That also keeps the fill opaque, which the strip needs
   * - the chrome covers the baseline under the active tab with it, and a
   * translucent fill would let the seam show through.
   */
  it("paints the editor's tab and the editing frame from the same token", () => {
    expect(SAMPLE_TAB_COLOR).toBe(EDITING_FRAME_COLOR);
    const color = `var(${SAMPLE_TAB_COLOR})`;
    render(
      createElement(TabChrome, {
        isActive: true,
        joined: true,
        concealed: false,
        color,
        session: true,
      }),
    );
    const box = screen.getByTestId("tab-chrome-box");
    expect(box.style.getPropertyValue("--swatch")).toBe(color);
    expect(box.style.getPropertyValue("--swatch-border")).toBe(
      "var(--canvas-border)",
    );
  });

  /**
   * The inner wash rectangle is GONE (L-138).
   *
   * It was a `rounded-md` box inset inside a tab whose real silhouette is an
   * S-curved trapezoid, washed with 16% of the colour and sitting behind the
   * label - so on a dark palette it read as a stray brown box rather than as
   * a signal, and it never touched the amber outline the same tab was already
   * wearing. The active tab now fills its own shape instead, so nothing here
   * should paint a second decoration on top of it.
   */
  it("leaves the active editor tab one treatment rather than two", () => {
    const { rerender } = render(
      createElement(HeaderTabVisual, sessionTabVisualProps(true)),
    );
    expect(
      document.querySelectorAll('[data-layout-session-tab="filled"]'),
    ).toHaveLength(1);
    expect(screen.getAllByTestId("tab-chrome-box")).toHaveLength(1);
    expect(screen.queryByTestId("tab-color-edge-line")).toBeNull();

    // The marker survives in both states, because the dim exemption reads it
    // and a tab the user clicked away from still has to stay lit.
    rerender(createElement(HeaderTabVisual, sessionTabVisualProps(false)));
    expect(
      document.querySelector('[data-layout-session-tab="rest"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("tab-chrome-box")).toBeNull();
  });

  /**
   * The other half of that one signal, and the reason it was unreadable: the
   * cap sat inside the tab strip's passive dim, so the mark that says "you are
   * customizing" was drawn at 45% opacity and 45% saturation (L-132). A dim
   * cannot be undone from below, so the scroller dims its MEMBERS and the
   * member carrying the session's mark is exempt - three artefacts that only
   * work together.
   */
  it("keeps the session's own tab out of the passive dim", () => {
    expect(DIM_RULE?.selector).toContain("[data-layout-passive-members]");
    expect(DIM_RULE?.selector).toContain(
      ":not(:has([data-layout-session-tab]))",
    );
    expect(read("components/layout/tabs/tab-strip.tsx")).toContain(
      "data-layout-passive-members",
    );
    render(createElement(HeaderTabVisual, sessionTabVisualProps(true)));
    expect(document.querySelector("[data-layout-session-tab]")).not.toBeNull();
    // The guide's lit moment (L-50) is the same dim with no session behind
    // it, so it has to be the same DECLARATIONS - not a second set that can
    // drift into a different treatment under the same name.
    expect(DIM_RULE?.selector).toContain('[data-layout-editing="1"]');
    expect(DIM_RULE?.selector).toContain('[data-layout-lit="1"]');
  });
});

describe("the canvas decoration across every built-in palette", () => {
  it("holds 3:1 for the hover outline on every surface", () => {
    expect(
      violations((palette, need) => {
        onSurfaces(palette, need, "hover outline", () =>
          themeToken(palette.tokens, HOVER_OUTLINE),
        );
      }),
    ).toEqual([]);
  });

  /**
   * The editing colour where it is a non-text INDICATOR owing 3:1 (1.4.11):
   * the 2px dotted frame around the app column, and the 3px cap the editor's
   * tab wears along its bottom edge at rest. One measurement covers both,
   * because the sibling test above asserts they are the same token.
   *
   * `--warning` is the tint of the status pair and is a mid amber in the light
   * palettes, which is why the pair's FOREGROUND is what ships here - the same
   * reason L-78 took `--foreground` over `--ring` for the selection outline.
   * Both land on the same surfaces: the tab strip sits on the app's header and
   * the frame runs around a column that can show any of them.
   *
   * The ACTIVE tab is not measured here, because there the colour is a
   * SURFACE. What it owes is the text on it, at 4.5, and that is the next
   * test.
   */
  it("holds 3:1 for the editing colour on every surface", () => {
    expect(
      violations((palette, need) => {
        onSurfaces(palette, need, "editing colour", () =>
          themeToken(palette.tokens, EDITING_FRAME_COLOR),
        );
      }),
    ).toEqual([]);
  });

  /**
   * The active session tab's own label, on the active session tab's own fill
   * (L-163, 1.4.3).
   *
   * This is the gate that says there is no share left to tune. The fill used
   * to be a dilution of the editing colour toward `--background`, and every
   * share is a trade between the tab reading as coloured and its label staying
   * legible on it: at 14% the tab read as black on Amoled, and at 32% the
   * label fell under 4.5:1 on six palette/mode pairs, with the largest share
   * that cleared every one of them at 4.5%. So the fill is the token
   * at full strength and the label is that token's own counterpart. Contrast
   * is symmetric, so this measures exactly what the palette already promises
   * for warning text on the background, and a palette that fails here is a
   * token defect rather than a number to tune.
   */
  it("holds 4.5:1 for the session tab's label on its own fill", () => {
    expect(
      violations((palette, need) =>
        need(
          "session tab label",
          themeToken(palette.tokens, SESSION_TAB_LABEL),
          themeToken(palette.tokens, SAMPLE_TAB_COLOR),
          TEXT,
        ),
      ),
    ).toEqual([]);
  });

  /**
   * The ring is several bands and the user sees the widest visible one, so
   * what it owes is that AT LEAST ONE solid band clears the floor on every
   * surface - not that its accent does. `--ring` alone does not: it is a soft
   * grey in this app's light palettes and measures 2.02:1 on `ayu/light`.
   */
  it("gives the travelling ring a band clear of 3:1 on every surface", () => {
    const failures: string[] = [];
    for (const palette of PALETTES) {
      for (const surface of SURFACES) {
        const ground = themeToken(palette.tokens, `--${surface}`);
        const best = Math.max(
          ...RING_BANDS.map((band) =>
            contrastRatio(themeToken(palette.tokens, band), ground),
          ),
        );
        if (best < NON_TEXT) {
          failures.push(
            `${palette.label} ring on ${surface}: best band ${best.toFixed(2)} < ${NON_TEXT}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The halo is the ring's outer, translucent band and the only thing
   * `prefers-reduced-transparency` drops. That is safe exactly because the
   * solid bands inside it carry the whole signal, so the fallback has to keep
   * every one of them.
   */
  it("keeps every solid band when the halo is dropped for reduced transparency", () => {
    const reducedRing = cssValue(
      under("prefers-reduced-transparency", (selector) =>
        selector.includes("[data-layout-selection-ring]"),
      ),
      "box-shadow",
    );
    expect(solidShadowTokens(reducedRing)).toEqual([...RING_BANDS]);
    expect(reducedRing).not.toContain("color-mix");
  });

  it("holds 4.5:1 for the name chip's text on its own fill", () => {
    expect(
      violations((palette, need) =>
        need(
          "chip text",
          themeToken(palette.tokens, CHIP_TEXT),
          themeToken(palette.tokens, CHIP_FILL),
          TEXT,
        ),
      ),
    ).toEqual([]);
  });

  /**
   * A ghost is the answer to "what is hidden here", and it appears among
   * leaves the session has already dimmed. Quieter than those, it is a
   * preview nobody finds - so the one thing it owes, on every palette, is to
   * be no fainter than the calm around it. Measured rather than compared as
   * two numbers, because the two opacities composite over different colours
   * once a palette's foreground is not pure black or white.
   */
  it("never draws a ghost fainter than the calm chrome around it", () => {
    const failures: string[] = [];
    for (const palette of PALETTES) {
      for (const surface of SURFACES) {
        const ground = themeToken(palette.tokens, `--${surface}`);
        const ink = themeToken(palette.tokens, "--foreground");
        const ghost = contrastRatio(
          compositeOverBackground(ink, GHOST_OPACITY, ground),
          ground,
        );
        const dimmed = contrastRatio(
          compositeOverBackground(ink, DIM_OPACITY, ground),
          ground,
        );
        if (ghost < dimmed) {
          failures.push(
            `${palette.label} ${surface}: ghost ${ghost.toFixed(2)} < dimmed ${dimmed.toFixed(2)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The Amoled guard. A 35% black scrim clears every ratio above and is
   * INVISIBLE on a black canvas, because it composites a colour that is
   * already there. An opacity cannot: it moves the leaf towards its own
   * surface whatever that surface is, so the lit chrome beside it always
   * stands off the dimmed chrome by a real margin.
   */
  it("is visibly a dim in every palette, blackest included", () => {
    const failures: string[] = [];
    for (const palette of PALETTES) {
      for (const surface of SURFACES) {
        const ground = themeToken(palette.tokens, `--${surface}`);
        const foreground = themeToken(palette.tokens, "--foreground");
        const lit = contrastRatio(foreground, ground);
        const dimmed = contrastRatio(
          compositeOverBackground(foreground, DIM_OPACITY, ground),
          ground,
        );
        if (dimmed >= lit * 0.7) {
          failures.push(
            `${palette.label} ${surface}: dimmed ${dimmed.toFixed(2)} vs lit ${lit.toFixed(2)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("the floating inspector's material", () => {
  it("holds 4.5:1 for body and muted text over every surface it can float above", () => {
    expect(
      violations((palette, need) => {
        for (const surface of SURFACES) {
          const behind = themeToken(palette.tokens, `--${surface}`);
          const material = compositeOverBackground(
            themeToken(palette.tokens, FLOAT_SURFACE),
            FLOAT_ALPHA,
            behind,
          );
          need(
            `body text over ${surface}`,
            themeToken(palette.tokens, "--card-foreground"),
            material,
            TEXT,
          );
          need(
            `muted text over ${surface}`,
            themeToken(palette.tokens, "--muted-foreground"),
            material,
            TEXT,
          );
        }
      }),
    ).toEqual([]);
  });

  it("holds 4.5:1 on the opaque card the reduced-transparency fallback becomes", () => {
    expect(
      violations((palette, need) => {
        const card = themeToken(palette.tokens, FLOAT_OPAQUE);
        need(
          "body text",
          themeToken(palette.tokens, "--card-foreground"),
          card,
          TEXT,
        );
        need(
          "muted text",
          themeToken(palette.tokens, "--muted-foreground"),
          card,
          TEXT,
        );
      }),
    ).toEqual([]);
  });

  it("holds 4.5:1 on the docked inspector's own surface", () => {
    expect(
      violations((palette, need) => {
        const panel = themeToken(palette.tokens, INSPECTOR_SURFACE);
        need(
          "body text",
          themeToken(palette.tokens, "--foreground"),
          panel,
          TEXT,
        );
        need(
          "muted text",
          themeToken(palette.tokens, "--muted-foreground"),
          panel,
          TEXT,
        );
      }),
    ).toEqual([]);
  });
});
