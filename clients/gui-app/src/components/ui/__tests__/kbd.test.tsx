/// <reference types="node" />
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { compile } from "tailwindcss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  contrastRatio,
  isFullPalettePreset,
  resolveThemeTokens,
  themePresets,
  themeToken,
  type ResolvedThemeMode,
} from "../../../../__tests__/contrast";

type ButtonVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link";

// Spelled out rather than scraped off the element: the source assertion below pins these exact strings as
// literals present in `kbd.tsx`, which is the half a scraping test could never check.
const FILLED_SURFACE_UTILITIES = [
  "in-[[data-slot=button]:is([data-variant=default],[data-variant=secondary])]:border-current",
  "in-[[data-slot=button]:is([data-variant=default],[data-variant=secondary])]:bg-transparent",
  "in-[[data-slot=button]:is([data-variant=default],[data-variant=secondary])]:text-current",
] as const;

interface FilledVariant {
  readonly variant: ButtonVariant;
  readonly fill: string;
  readonly label: string;
}

/** The variants painting an opaque fill. */
const FILLED_VARIANTS: ReadonlyArray<FilledVariant> = [
  { variant: "default", fill: "--primary", label: "--primary-foreground" },
  {
    variant: "secondary",
    fill: "--secondary",
    label: "--secondary-foreground",
  },
];

const AMBIENT_VARIANTS: ReadonlyArray<ButtonVariant> = [
  "outline",
  "ghost",
  "link",
  "destructive",
];

const MODES: ReadonlyArray<ResolvedThemeMode> = ["light", "dark"];

/** (`@tailwindcss/oxide` would scan it properly, but it is not a declared dependency of the oss repo.) */
function kbdSource(): string {
  return readFileSync(
    join(process.cwd(), "src", "components", "ui", "kbd.tsx"),
    "utf8",
  );
}

/** A candidate that produces no rule yields no entry, which is what lets the assertions below tell "the rule
 * applies" apart from "nothing was generated". */
async function emittedSelectors(
  candidates: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const entry = createRequire(join(process.cwd(), "package.json")).resolve(
    "tailwindcss/index.css",
  );
  const compiler = await compile('@import "tailwindcss";', {
    base: process.cwd(),
    loadStylesheet: async (id: string, base: string) => {
      // Called exactly once, for the `@import` above: 4.3.3's `index.css` inlines its theme/base/utilities layers
      // rather than `@import`ing the sibling `theme.css` / `preflight.css` / `utilities.css` of those names.
      if (id !== "tailwindcss") {
        throw new Error(`Unexpected stylesheet import ${id} from ${base}`);
      }
      return {
        path: entry,
        base: dirname(entry),
        content: await readFile(entry, "utf8"),
      };
    },
  });
  const css = compiler.build([...candidates]);
  const selectors = new Map<string, string>();
  // The only nesting in the output is the `@supports (color: color-mix(…))` fallback inside a declaration block,
  // which is what the `@` filter drops.
  const rules = css
    .split("\n")
    .flatMap((line) => {
      const rule = /^\s*(\S.*?)\s*\{\s*$/.exec(line);
      return rule === null ? [] : [rule[1]];
    })
    .filter((rule) => !rule.startsWith("@"));
  for (const candidate of candidates) {
    // Tailwind escapes every character outside `[A-Za-z0-9_-]`.
    const escaped = candidate.replace(
      /[^a-zA-Z0-9_-]/g,
      (character) => `\\${character}`,
    );
    const hit = rules.find((rule) => rule.includes(`.${escaped}`));
    if (hit !== undefined) selectors.set(candidate, hit);
  }
  return selectors;
}

function renderKeycap(variant: ButtonVariant): Element {
  const { container } = render(
    <Button variant={variant}>
      Next
      <Kbd>↵</Kbd>
    </Button>,
  );
  const keycap = container.querySelector('[data-slot="kbd"]');
  if (keycap === null) throw new Error(`No keycap rendered for ${variant}`);
  return keycap;
}

describe("Kbd on a button surface", () => {
  let emitted: ReadonlyMap<string, string> = new Map();

  beforeAll(async () => {
    emitted = await emittedSelectors(FILLED_SURFACE_UTILITIES);
  });

  afterEach(cleanup);

  it("ships the filled-surface utilities as literals the content scan can see", () => {
    const source = kbdSource();
    for (const candidate of FILLED_SURFACE_UTILITIES) {
      expect(source.includes(candidate), candidate).toBe(true);
    }
  });

  it("scopes every button-keyed rule it ships to the two filled variants", () => {
    // Derived from the source rather than the constant above, so a fourth button-scoped rule - `destructive`, say,
    // where `text-current` measures worse (nord dark 5.96 -> 2.79).
    const shipped = kbdSource().match(/in-\[\[data-slot=button\][^"`]*/g) ?? [];
    expect(shipped.length).toBe(FILLED_SURFACE_UTILITIES.length);
    for (const candidate of shipped) {
      expect(FILLED_SURFACE_UTILITIES, candidate).toContain(candidate);
    }
  });

  it("compiles each of them to a real rule", () => {
    for (const candidate of FILLED_SURFACE_UTILITIES) {
      expect(emitted.get(candidate), candidate).toBeTypeOf("string");
    }
  });

  it("resolves the emitted rules inside a filled button", () => {
    for (const { variant } of FILLED_VARIANTS) {
      const keycap = renderKeycap(variant);
      for (const candidate of FILLED_SURFACE_UTILITIES) {
        const selector = emitted.get(candidate);
        expect(selector, candidate).toBeTypeOf("string");
        // `:not(*)` never matches, so a missing rule fails rather than
        // throwing an unrelated selector-syntax error.
        expect(
          keycap.matches(selector ?? ":not(*)"),
          `${variant} / ${selector}`,
        ).toBe(true);
      }
    }
  });

  it("leaves the ambient calibration alone on every other variant", () => {
    for (const variant of AMBIENT_VARIANTS) {
      const keycap = renderKeycap(variant);
      for (const candidate of FILLED_SURFACE_UTILITIES) {
        const selector = emitted.get(candidate);
        expect(selector, candidate).toBeTypeOf("string");
        expect(
          keycap.matches(selector ?? ":not(*)"),
          `${variant} / ${selector}`,
        ).toBe(false);
      }
      // Exact tokens, not `toContain` on the joined string: a substring check passes for `bg-foreground/80` and
      // `text-muted-foreground/70`, i.e. for the very alpha drift that would quietly dim the ambient keycap.
      const tokens = keycap.className.split(" ");
      expect(tokens, variant).toContain("bg-foreground/8");
      expect(tokens, variant).toContain("text-muted-foreground");
    }
  });

  it("keeps both attribute anchors the rule depends on on the button itself", () => {
    // `Button` dropping either attribute would silently un-fix every keycap
    // while the classes sat unchanged in the markup.
    const { container } = render(
      <Button variant="default">
        Next
        <Kbd>↵</Kbd>
      </Button>,
    );
    const button = container.querySelector("button");
    expect(button?.getAttribute("data-slot")).toBe("button");
    expect(button?.getAttribute("data-variant")).toBe("default");
  });
});

// The preset set is pinned to the app's `THEME_PRESETS` registry inside `contrast.ts`, so a preset the parser
// fails to see is a loud error rather than a smaller sweep.
describe("Kbd contrast on a filled button, per theme", () => {
  const presets = themePresets();

  it("improves the keycap in every preset and mode by riding the button's own label color", () => {
    const regressions: string[] = [];
    for (const theme of presets) {
      for (const mode of MODES) {
        const tokens = resolveThemeTokens(theme, mode);
        for (const { variant, fill, label } of FILLED_VARIANTS) {
          const background = themeToken(tokens, fill);
          const ambient = contrastRatio(
            themeToken(tokens, "--muted-foreground"),
            background,
          );
          const riding = contrastRatio(themeToken(tokens, label), background);
          if (riding < ambient) {
            regressions.push(
              `${theme} ${mode} ${variant}: ${ambient.toFixed(2)} -> ${riding.toFixed(2)}`,
            );
          }
        }
      }
    }
    expect(regressions).toEqual([]);
  });

  it("clears 4.5:1 on a primary button in every full-palette preset", () => {
    const failures: string[] = [];
    for (const theme of presets) {
      for (const mode of MODES) {
        if (!isFullPalettePreset(theme, mode)) continue;
        const tokens = resolveThemeTokens(theme, mode);
        const ratio = contrastRatio(
          themeToken(tokens, "--primary-foreground"),
          themeToken(tokens, "--primary"),
        );
        if (ratio < 4.5) failures.push(`${theme} ${mode}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
