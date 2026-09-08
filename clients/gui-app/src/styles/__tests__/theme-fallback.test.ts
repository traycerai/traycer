import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { baseThemeColors } from "@/lib/themes/builtin-palettes";

const FALLBACK_CSS = readFileSync(
  path.resolve(__dirname, "../theme-fallback.css"),
  "utf8",
);
const INDEX_CSS = readFileSync(
  path.resolve(__dirname, "../../index.css"),
  "utf8",
);

function fallbackDeclarations(): Map<string, string> {
  return new Map(
    [...FALLBACK_CSS.matchAll(/^\s+--([^:]+):\s*([^;]+);/gm)].map(
      ([, token, value]) => [token, value] as const,
    ),
  );
}

describe("theme fallback stylesheet", () => {
  it("is generated, loaded before runtime themes, and covers the base palette", () => {
    expect(INDEX_CSS).toContain('@import "./styles/theme-fallback.css";');

    expect(FALLBACK_CSS).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark;/s);
    expect(FALLBACK_CSS).toMatch(
      /:root\.light\s*\{\s*color-scheme:\s*light;\s*\}/s,
    );
    expect(FALLBACK_CSS).toMatch(
      /:root\.dark\s*\{\s*color-scheme:\s*dark;\s*\}/s,
    );

    const declarations = fallbackDeclarations();
    const lightTokens = new Set(Object.keys(baseThemeColors.light));
    const darkColors = new Map(Object.entries(baseThemeColors.dark));
    for (const token of Object.keys(baseThemeColors.dark)) {
      expect(lightTokens.has(token), `base token --${token}`).toBe(true);
    }
    for (const [token, light] of Object.entries(baseThemeColors.light)) {
      const dark = darkColors.get(token);
      const expected =
        light === dark ? light : `light-dark(${light}, ${dark ?? light})`;
      expect(
        declarations.get(token)?.replace(/\s+/g, ""),
        `fallback --${token}`,
      ).toBe(expected.replace(/\s+/g, ""));
    }
  });
});
