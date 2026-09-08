import { getBuiltinThemeColors } from "./builtin-palettes";
import {
  normalizeThemeColor,
  isThemeToken,
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
      reference && isThemeToken(reference) ? (source[reference] ?? "") : value,
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
  const name = themes.length === 1 ? themes[0].name : "traycer-themes";
  anchor.download = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Include sibling variants only when the source is a complete extension pack. */
export function getThemeImportConflicts(
  saved: ThemeDefinition[],
  imported: ThemeDefinition[],
  replaceCollectionIds: readonly string[],
): ThemeDefinition[] {
  const ids = new Set(imported.map((theme) => theme.id));
  const collections = new Set(replaceCollectionIds);
  return saved.filter(
    (theme) =>
      ids.has(theme.id) ||
      (theme.collection !== undefined && collections.has(theme.collection.id)),
  );
}
