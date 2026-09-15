import { beforeEach, describe, expect, it } from "vitest";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import { themeDefinitionSchema } from "@/lib/themes/theme-definition";
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
    version: 2,
    themes: [],
    selected: { light: null, dark: null },
    contrast: 100,
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

  // The reasoning slider's max accent is a role like any other: a custom theme
  // that names it parses, the applier writes it to the root, and clearing the
  // selection puts the built-in violet back.
  it("applies and resets a custom reasoning max accent", () => {
    const root = document.documentElement;
    const parsed = themeDefinitionSchema.safeParse({
      ...createThemeFromPreset("neutral", "dark"),
      id: "max-accent-theme",
      colors: {
        ...createThemeFromPreset("neutral", "dark").colors,
        "reasoning-max-accent": "#ff8800",
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    useSettingsStore.setState({ theme: "dark", themePreset: "neutral" });

    expect(useThemeLibraryStore.getState().saveTheme(parsed.data)).toBe(true);
    expect(root.style.getPropertyValue("--reasoning-max-accent")).toBe(
      "#ff8800ff",
    );

    expect(useThemeLibraryStore.getState().clearSelection()).toBe(true);
    expect(root.style.getPropertyValue("--reasoning-max-accent")).toBe(
      getBuiltinThemeColors("neutral", "dark")["reasoning-max-accent"],
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

  it("adjusts contrast against solid surface tokens", () => {
    const root = document.documentElement;
    useSettingsStore.setState({ theme: "dark", themePreset: "amoled" });
    const builtins = getBuiltinThemeColors("amoled", "dark");
    expect(root.style.getPropertyValue("--popover")).toBe(builtins.popover);
    expect(root.style.getPropertyValue("--card")).toBe(builtins.card);
    const solidPopoverForeground = root.style.getPropertyValue(
      "--popover-foreground",
    );
    const solidCardForeground =
      root.style.getPropertyValue("--card-foreground");

    expect(
      useThemeLibraryStore.getState().setAppearancePreference({ contrast: 70 }),
    ).toBe(true);
    expect(root.style.getPropertyValue("--popover-foreground")).toBe(
      root.style.getPropertyValue("--card-foreground"),
    );
    expect(root.style.getPropertyValue("--popover-foreground")).not.toBe(
      solidPopoverForeground,
    );
    expect(root.style.getPropertyValue("--card-foreground")).not.toBe(
      solidCardForeground,
    );

    expect(
      useThemeLibraryStore
        .getState()
        .setAppearancePreference({ contrast: 100 }),
    ).toBe(true);
    expect(root.style.getPropertyValue("--popover-foreground")).toBe(
      builtins["popover-foreground"],
    );
  });

  // Border visibility repair now runs once, at VS Code import time
  // (`theme-import.ts`), not a second time here keyed off "has syntax
  // colors" - see `lib/themes/__tests__/theme-customization.test.ts` for
  // coverage of the import-time fix-up itself.
});
