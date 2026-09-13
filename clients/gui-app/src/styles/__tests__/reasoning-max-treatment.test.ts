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

  it("builds the max fill and glow out of the two tokens and no literal hue", () => {
    const range = /\.reasoning-effort-max-range\s*\{([^}]*)\}/.exec(INDEX_CSS);
    expect(range?.[1]).toContain("var(--primary)");
    expect(range?.[1]).toContain("var(--reasoning-max-accent)");
    // Right-to-left has its own gradient: a mirrored one would run the accent
    // back into the low end of the ladder.
    expect(INDEX_CSS).toMatch(/\[dir="rtl"\]\s*\.reasoning-effort-max-range/);

    const glow = /\.reasoning-effort-max-glow\s*\{([^}]*)\}/.exec(INDEX_CSS);
    // 12px blur + 2px spread = the 14px the row's `py-2` plus the footer's
    // `py-1.5` reserves against the popover's `overflow-hidden`.
    expect(glow?.[1]).toContain("0 0 12px 2px var(--reasoning-max-glow)");
  });

  it("keeps every continuous effect off CSS animation", () => {
    // The sparkles ride the shared status clock; an `animation` here would
    // cost a main-thread style recalc per display frame for as long as max is
    // selected. Both sparkle rules are static paint only.
    for (const selector of [
      ".reasoning-effort-sparkle",
      ".reasoning-effort-sparkle-glint",
    ]) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(INDEX_CSS);
      expect(rule?.[1], selector).not.toContain("animation");
    }
  });

  it("has retired the bloom, the tail and the flow entirely", () => {
    for (const gone of [
      "reasoning-max-bloom",
      "reasoning-effort-bloom",
      "reasoning-effort-max-tail",
      "reasoning-effort-max-flow",
      "reasoning-effort-thumb-core",
      "--reasoning-max-ring",
      "--reasoning-max-halo",
    ]) {
      expect(INDEX_CSS, gone).not.toContain(gone);
    }
  });
});
