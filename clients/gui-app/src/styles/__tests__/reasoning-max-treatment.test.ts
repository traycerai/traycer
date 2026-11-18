import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseThemeColors } from "@/lib/themes/builtin-palettes";
import { isThemeToken } from "@/lib/themes/theme-definition";

const INDEX_CSS = readFileSync(
  path.resolve(__dirname, "../../index.css"),
  "utf8",
);

/**
 * The body of the FIRST `@media (prefers-reduced-motion: reduce) { ... }`
 * block whose body contains `marker` - `index.css` carries several such
 * blocks for unrelated features, so grabbing "the first one in the file"
 * (a plain regex `.exec`) silently reads someone else's block. Brace-depth
 * scanned rather than regex-matched on the closing `}`, so it does not
 * depend on any particular indentation of that brace.
 */
function reducedMotionBlockContaining(marker: string): string {
  const opener = "@media (prefers-reduced-motion: reduce) {";
  let searchFrom = 0;
  for (;;) {
    const start = INDEX_CSS.indexOf(opener, searchFrom);
    if (start === -1) {
      throw new Error(
        `No "prefers-reduced-motion: reduce" block contains "${marker}"`,
      );
    }
    const openBrace = start + opener.length - 1;
    let depth = 0;
    let close = -1;
    for (let i = openBrace; i < INDEX_CSS.length; i += 1) {
      if (INDEX_CSS[i] === "{") depth += 1;
      else if (INDEX_CSS[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) throw new Error("Unbalanced braces in index.css");
    const body = INDEX_CSS.slice(openBrace + 1, close);
    if (body.includes(marker)) return body;
    searchFrom = close + 1;
  }
}

/**
 * The stylesheet half of the reasoning slider's max treatment, which no jsdom
 * render can see: jsdom applies no Tailwind and computes no `box-shadow`, so
 * the component tests can only prove the right CLASS is on the right node. What
 * that class means lives here.
 */
describe("reasoning slider max treatment (index.css)", () => {
  it("takes the accent from the theme token registry and aliases it into Tailwind", () => {
    // A registered role, not a literal in this file: the applier writes it,
    // the fallback stylesheet carries its default, and a custom theme
    // overrides it like `--primary`. `index.css` only aliases it so the
    // colour namespace can reach it.
    expect(isThemeToken("reasoning-max-accent")).toBe(true);
    expect(baseThemeColors.light["reasoning-max-accent"]).toMatch(/^oklch\(/);
    expect(baseThemeColors.dark["reasoning-max-accent"]).toMatch(/^oklch\(/);
    expect(INDEX_CSS).not.toMatch(/^\s*--reasoning-max-accent:/m);
    expect(INDEX_CSS).toContain(
      "--color-reasoning-max-accent: var(--reasoning-max-accent);",
    );
  });

  it("builds the max fill out of the two tokens and no literal hue, as a crossfade over the range", () => {
    // The gradient now lives on the range's `::after` (a crossfade), not on
    // `.reasoning-effort-max-range` itself - that class only toggles the
    // overlay's opacity.
    const overlay = /\.reasoning-effort-range::after\s*\{([^}]*)\}/.exec(
      INDEX_CSS,
    );
    expect(overlay?.[1]).toContain("var(--primary)");
    expect(overlay?.[1]).toContain("var(--reasoning-max-accent)");
    expect(overlay?.[1]).toContain("opacity: 0");

    const maxOverlay = /\.reasoning-effort-max-range::after\s*\{([^}]*)\}/.exec(
      INDEX_CSS,
    );
    expect(maxOverlay?.[1]).toContain("opacity: 1");

    // Right-to-left has its own gradient on the same overlay: a mirrored one
    // would run the accent back into the low end of the ladder.
    expect(INDEX_CSS).toMatch(
      /\[dir="rtl"\]\s*\.reasoning-effort-range::after/,
    );

    const glow = /\.reasoning-effort-max-glow\s*\{([^}]*)\}/.exec(INDEX_CSS);
    // The bloom is gone - a fine 1px edge, still token-built, no literal hue.
    expect(glow?.[1]).toContain("var(--reasoning-max-accent)");
    expect(glow?.[1]).toContain("color-mix");
    expect(glow?.[1]).toContain("0 0 0 1px");
  });

  it("keeps the per-point sparkles off CSS animation - their opacity and drift stay clock-written", () => {
    // The sparkles ride the shared status clock; a continuous `animation`
    // here would cost a main-thread style recalc per display frame for as
    // long as max is selected. Both sparkle rules are static paint only.
    for (const selector of [
      ".reasoning-effort-sparkle",
      ".reasoning-effort-sparkle-glint",
    ]) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(INDEX_CSS);
      expect(rule?.[1], selector).not.toContain("animation");
    }
  });

  it("gives the sparkle field a finite entry animation, disabled under reduced motion", () => {
    // The field itself gets a one-shot fade-in on mount - finite (`320ms ...
    // both`), never `infinite`, so it can't become the continuous cost the
    // per-sparkle rules above are kept free of.
    const field = /\.reasoning-effort-max-sparkles\s*\{([^}]*)\}/.exec(
      INDEX_CSS,
    );
    expect(field?.[1]).toContain("320ms");
    expect(field?.[1]).not.toContain("infinite");
    expect(INDEX_CSS).toMatch(/@keyframes reasoning-sparkles-enter\s*\{/);

    const reducedMotion = reducedMotionBlockContaining(
      ".reasoning-effort-max-sparkles",
    );
    // The travel transitions (range crossfade, thumb/range easing) and the
    // sparkle field's entry animation are each gated off under reduced
    // motion - the per-tick clock writes are untouched (see the component:
    // `useStatusAnimation` already stops writing then).
    expect(reducedMotion).toContain("transition: none");
    expect(reducedMotion).toContain("animation: none");
  });

  it("has retired the bloom, the tail, the flow, and the old glow tokens entirely", () => {
    for (const gone of [
      "reasoning-max-bloom",
      "reasoning-effort-bloom",
      "reasoning-effort-max-tail",
      "reasoning-effort-max-flow",
      "reasoning-effort-thumb-core",
      "--reasoning-max-ring",
      "--reasoning-max-halo",
      // Replaced by the inline `color-mix()` on `.reasoning-effort-max-glow`
      // once the bloom's blur/spread glow gave way to the fine edge.
      "--reasoning-max-glow",
      "--reasoning-max-edge",
    ]) {
      expect(INDEX_CSS, gone).not.toContain(gone);
    }
  });
});
