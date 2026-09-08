import { getBuiltinThemeColors } from "./builtin-palettes";
import {
  normalizeThemeColor,
  themeTokenNames,
  type ThemeDefinition,
  type ThemeToken,
} from "./theme-definition";
import { findThemePreset, type ThemePreset } from "@/lib/theme-presets";

export function createThemeFromPreset(
  preset: ThemePreset,
  appearance: "light" | "dark",
): ThemeDefinition {
  const source = getBuiltinThemeColors(preset, appearance);
  const colors: Partial<Record<ThemeToken, string>> = {};
  for (const token of themeTokenNames) {
    const value = source[token];
    if (!value) continue;
    const reference = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
    const color = normalizeThemeColor(
      reference && themeTokenNames.some((name) => name === reference)
        ? (source[reference as ThemeToken] ?? "")
        : value,
    );
    if (color) colors[token] = color;
  }
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: `${findThemePreset(preset).label} custom`,
    appearance,
    base: preset,
    colors,
    syntax: null,
  };
}

export function exportThemes(themes: ThemeDefinition[]): void {
  const blob = new Blob(
    [JSON.stringify(themes.length === 1 ? themes[0] : themes, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${(themes[0]?.name ?? "traycer-themes").replace(/[^a-zA-Z0-9_-]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
