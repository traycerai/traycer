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
    version: 2,
    themes: [],
    selected: { light: null, dark: null },
    glassOpacity: 100,
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

  it("marks glass-enabled state only below fully opaque glass", () => {
    const root = document.documentElement;

    expect(root.hasAttribute("data-glass-enabled")).toBe(false);
    expect(useThemeLibraryStore.getState().setGlassOpacity(50)).toBe(true);
    expect(root.hasAttribute("data-glass-enabled")).toBe(true);
    expect(useThemeLibraryStore.getState().setGlassOpacity(100)).toBe(true);
    expect(root.hasAttribute("data-glass-enabled")).toBe(false);
  });

  it("optimizes glass surfaces against the translucent colour they ship", () => {
    // Below 100% the CSS never paints --popover; it paints --popover mixed
    // into the page at --glass-opacity. A contrast below 100 pulls the
    // foreground toward that background, so the mixed surface is observable -
    // on a palette whose dark popover differs from its page background, which
    // the default neutral one does not.
    const root = document.documentElement;
    useSettingsStore.setState({ theme: "dark", themePreset: "amoled" });
    const library = useThemeLibraryStore.getState();
    expect(library.setAppearancePreference({ contrast: 70 })).toBe(true);

    const solidPopover = root.style.getPropertyValue("--popover-foreground");
    const solidCard = root.style.getPropertyValue("--card-foreground");
    const pageForeground = root.style.getPropertyValue("--foreground");
    expect(solidPopover).not.toBe("");

    expect(useThemeLibraryStore.getState().setGlassOpacity(100)).toBe(true);
    expect(root.style.getPropertyValue("--popover-foreground")).toBe(
      solidPopover,
    );

    expect(useThemeLibraryStore.getState().setGlassOpacity(30)).toBe(true);
    expect(root.style.getPropertyValue("--popover-foreground")).not.toBe(
      solidPopover,
    );
    // Rows already keyed off the page background are unaffected by glass.
    expect(root.style.getPropertyValue("--foreground")).toBe(pageForeground);
    // Nothing glass tints from --card, so its foreground must never be
    // pulled toward the page the way --popover-foreground just was.
    expect(root.style.getPropertyValue("--card-foreground")).toBe(solidCard);
  });

  // Border visibility repair now runs once, at VS Code import time
  // (`theme-import.ts`), not a second time here keyed off "has syntax
  // colors" - see `lib/themes/__tests__/theme-customization.test.ts` for
  // coverage of the import-time fix-up itself.
});
