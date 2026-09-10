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

function declarationsIn(css: string): Map<string, string> {
  return new Map(
    [...css.matchAll(/^\s+--([^:]+):\s*([^;]+);/gm)].map(
      ([, token, value]) => [token, value] as const,
    ),
  );
}

const staticRoot = /:root\s*\{([^{}]*)\}/s.exec(FALLBACK_CSS)?.[1] ?? "";
const dynamicRoot =
  /@supports[\s\S]*?:root\s*\{([^{}]*)\}/s.exec(FALLBACK_CSS)?.[1] ?? "";

describe("theme fallback stylesheet", () => {
  it("is generated, loaded before runtime themes, and covers the base palette", () => {
    const fallbackImport = INDEX_CSS.indexOf(
      '@import "./styles/theme-fallback.css";',
    );
    const surfacesImport = INDEX_CSS.indexOf(
      '@import "./styles/theme-surfaces.css";',
    );
    expect(fallbackImport).toBeGreaterThanOrEqual(0);
    expect(surfacesImport).toBeGreaterThan(fallbackImport);

    expect(staticRoot).toMatch(/color-scheme:\s*light dark;/);
    expect(FALLBACK_CSS).toMatch(
      /:root\.light\s*\{\s*color-scheme:\s*light;\s*\}/s,
    );
    expect(FALLBACK_CSS).toMatch(
      /:root\.dark\s*\{\s*color-scheme:\s*dark;\s*\}/s,
    );

    expect(dynamicRoot).not.toBe("");
    const staticDeclarations = declarationsIn(staticRoot);
    const dynamicDeclarations = declarationsIn(dynamicRoot);
    const lightTokens = new Set(Object.keys(baseThemeColors.light));
    const darkColors = new Map(Object.entries(baseThemeColors.dark));
    for (const token of Object.keys(baseThemeColors.dark)) {
      expect(lightTokens.has(token), `base token --${token}`).toBe(true);
    }
    for (const [token, light] of Object.entries(baseThemeColors.light)) {
      const dark = darkColors.get(token);
      expect(staticDeclarations.get(token), `static fallback --${token}`).toBe(
        light,
      );
      const expected =
        light === dark ? light : `light-dark(${light}, ${dark ?? light})`;
      expect(
        dynamicDeclarations.get(token)?.replace(/\s+/g, ""),
        `dynamic fallback --${token}`,
      ).toBe(expected.replace(/\s+/g, ""));
    }
  });
});
