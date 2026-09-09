import { beforeEach, describe, expect, it } from "vitest";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import { createThemeFromPreset } from "@/lib/themes/theme-library";
import {
  getActiveThemeDefinition,
  getThemeRevision,
} from "@/lib/theme-applier";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

function resetThemeState(): void {
  window.localStorage.clear();
  useThemeLibraryStore.setState({
    version: 1,
    themes: [],
    selected: { light: null, dark: null },
    glassOpacity: 100,
    draft: null,
    error: null,
  });
  useSettingsStore.setState({ theme: "light", themePreset: "neutral" });
}

describe("theme applier", () => {
  beforeEach(resetThemeState);

  it("increments synchronously when a saved theme keeps the same id", () => {
    const first = {
      ...createThemeFromPreset("neutral", "light"),
      id: "same-theme-id",
      colors: {
        ...createThemeFromPreset("neutral", "light").colors,
        primary: "#123456",
      },
    };
    expect(useThemeLibraryStore.getState().saveTheme(first)).toBe(true);
    expect(getActiveThemeDefinition()?.id).toBe(first.id);
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#123456ff",
    );

    const before = getThemeRevision();
    const second = {
      ...first,
      colors: { ...first.colors, primary: "#abcdef" },
    };
    expect(useThemeLibraryStore.getState().saveTheme(second)).toBe(true);

    expect(getThemeRevision()).toBeGreaterThan(before);
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#abcdefff",
    );
  });

  it("restores built-in values after removing a custom selection", () => {
    const custom = {
      ...createThemeFromPreset("neutral", "light"),
      id: "custom-theme-id",
      colors: {
        ...createThemeFromPreset("neutral", "light").colors,
        primary: "#123456",
        "term-ansi-red": "#654321",
      },
    };
    expect(useThemeLibraryStore.getState().saveTheme(custom)).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue("--term-ansi-red"),
    ).toBe("#654321ff");

    expect(useThemeLibraryStore.getState().clearSelection()).toBe(true);
    const builtins = getBuiltinThemeColors("neutral", "light");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe(
      "neutral",
    );
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      builtins.primary,
    );
    expect(
      document.documentElement.style.getPropertyValue("--term-ansi-red"),
    ).toBe(builtins["term-ansi-red"]);
  });
});
