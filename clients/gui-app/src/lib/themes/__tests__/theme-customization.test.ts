import { zipSync, strToU8 } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeThemeColor,
  themeDefinitionSchema,
  type ThemeDefinition,
} from "@/lib/themes/theme-definition";
import { importThemePackage, importThemeText } from "@/lib/themes/theme-import";
import { createThemeFromPreset } from "@/lib/themes/theme-library";

function nativeTheme(
  overrides: Partial<ThemeDefinition> = {},
): ThemeDefinition {
  return {
    version: 1,
    id: "native-theme",
    name: "Native theme",
    appearance: "dark",
    base: "neutral",
    colors: { primary: "#123456" },
    syntax: null,
    ...overrides,
  };
}

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path, strToU8(text)]),
    ),
  );
}

function manifest(path: string): string {
  return JSON.stringify({
    displayName: "Fixture themes",
    publisher: "fixture",
    name: "theme-pack",
    contributes: { themes: [{ label: "Fixture", path, uiTheme: "vs-dark" }] },
  });
}

describe("theme customization contract", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme-id");
  });

  it("normalizes literal colors and rejects unknown semantic tokens", () => {
    expect(normalizeThemeColor(" #abc ")).toBe("#aabbccff");
    expect(normalizeThemeColor("var(--primary)")).toBeNull();

    const parsed = themeDefinitionSchema.safeParse({
      ...nativeTheme(),
      colors: { unknown: "#123456" },
    });
    expect(parsed.success).toBe(false);
  });

  it("imports native Traycer JSONC and preserves normalized syntax", () => {
    const [theme] = importThemeText(
      `{
        // JSONC comments and trailing commas are accepted.
        "version": 1,
        "id": "from-file",
        "name": "From file",
        "appearance": "light",
        "base": "neutral",
        "colors": { "primary": "#123456" },
        "syntax": {
          "colors": { "editor.background": "#101010" },
          "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#abcdef", "fontStyle": "italic" } }]
        },
      }`,
      "native",
    );

    expect(theme.name).toBe("From file");
    expect(theme.id).not.toBe("from-file");
    expect(theme.colors.primary).toBe("#123456ff");
    expect(theme.syntax?.colors["editor.background"]).toBe("#101010ff");
    expect(theme.syntax?.tokenColors[0]?.settings.foreground).toBe("#abcdefff");
    expect(theme.syntax?.tokenColors[0]?.settings.fontStyle).toBe("italic");
  });

  it("converts VS Code JSONC, including ANSI and token syntax", () => {
    const longScope = "scope.".repeat(120);
    const [theme] = importThemeText(
      `{
        "name": "VS Code fixture",
        "type": "dark",
        "colors": {
          "editor.background": "#101010",
          "button.background": "#336699",
          "terminal.ansiRed": "#ff0000"
        },
        "tokenColors": [{ "scope": ["${longScope}"], "settings": { "foreground": "#abcdef", "fontStyle": "normal bold underline regular" } }]
      }`,
      "fallback",
    );

    expect(theme.name).toBe("VS Code fixture");
    expect(theme.colors.background).toBe("#101010ff");
    expect(theme.colors.primary).toBe("#336699ff");
    expect(theme.colors["term-ansi-red"]).toBe("#ff0000ff");
    expect(theme.syntax?.tokenColors[0]?.scope).toEqual([longScope]);
    expect(theme.syntax?.tokenColors[0]?.settings.fontStyle).toBe(
      "bold underline",
    );
  });

  it("resolves real VSIX includes and keeps collection identity", async () => {
    const bytes = pack({
      "extension/package.json": manifest("themes/child.json"),
      "extension/themes/base.json": JSON.stringify({
        name: "Base",
        colors: {
          "editor.background": "#101010",
          "terminal.ansiGreen": "#00ff00",
        },
        tokenColors: [
          { scope: "comment", settings: { foreground: "#abcdef" } },
        ],
      }),
      "extension/themes/child.json": JSON.stringify({
        include: "./base.json",
        name: "Child",
        colors: { "terminal.ansiRed": "#ff0000" },
        tokenColors: [
          { scope: "keyword", settings: { foreground: "#ff00ff" } },
        ],
      }),
    });

    const [theme] = await importThemePackage(bytes);
    expect(theme.collection).toEqual({
      id: "vsix:fixture.theme-pack",
      name: "Fixture themes",
    });
    expect(theme.colors.background).toBe("#101010ff");
    expect(theme.colors["term-ansi-green"]).toBe("#00ff00ff");
    expect(theme.colors["term-ansi-red"]).toBe("#ff0000ff");
    expect(theme.syntax?.tokenColors).toHaveLength(2);
    expect(theme.syntax?.tokenColors.map((rule) => rule.scope)).toEqual([
      "comment",
      "keyword",
    ]);
  });

  it("rejects include cycles and paths that escape the extension", async () => {
    const cycle = pack({
      "extension/package.json": manifest("themes/a.json"),
      "extension/themes/a.json": JSON.stringify({ include: "./b.json" }),
      "extension/themes/b.json": JSON.stringify({ include: "./a.json" }),
    });
    await expect(importThemePackage(cycle)).rejects.toThrow(
      "circular includes",
    );

    const escape = pack({
      "extension/package.json": manifest("../outside.json"),
      "extension/outside.json": JSON.stringify({ colors: {} }),
    });
    await expect(importThemePackage(escape)).rejects.toThrow(
      "escapes the extension package",
    );
  });

  it("creates a complete editable palette from a built-in preset", () => {
    const theme = createThemeFromPreset("neutral", "dark");
    expect(theme.colors.background).toBeDefined();
    expect(theme.colors.primary).toBeDefined();
    expect(theme.syntax).toBeNull();
    expect(theme.appearance).toBe("dark");
  });
});
