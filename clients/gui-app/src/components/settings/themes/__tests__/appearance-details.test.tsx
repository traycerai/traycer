import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceDetails } from "@/components/settings/themes/appearance-details";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

vi.mock("@/hooks/runner/use-runner-installed-fonts-query", () => ({
  useRunnerInstalledFontsQuery: () => ({ data: [] }),
}));

function resetThemeLibrary(): void {
  window.localStorage.clear();
  useThemeLibraryStore.setState({
    version: 1,
    themes: [],
    selected: { light: null, dark: null },
    glassOpacity: 100,
    promptFontFamily: null,
    promptFontSize: 14,
    fontLigatures: true,
    panelAnimations: true,
    panelAnimationDuration: 100,
    contrast: 100,
    draft: null,
    error: null,
  });
}

beforeEach(resetThemeLibrary);
afterEach(() => {
  cleanup();
  resetThemeLibrary();
});

describe("AppearanceDetails advanced options", () => {
  it("uses a closed disclosure and preserves preferences when collapsed", () => {
    render(<AppearanceDetails />);

    expect(
      screen.queryByRole("switch", { name: "Advanced options" }),
    ).toBeNull();
    expect(screen.queryByRole("switch", { name: "Font ligatures" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Advanced options" }));

    expect(screen.getByRole("switch", { name: "Font ligatures" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Panel animations" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Panel animation duration")).toBeTruthy();
    expect(screen.getByLabelText("Appearance contrast")).toBeTruthy();

    const beforeCollapse = useThemeLibraryStore.getState();
    fireEvent.click(screen.getByRole("button", { name: "Advanced options" }));

    expect(screen.queryByRole("switch", { name: "Font ligatures" })).toBeNull();
    const afterCollapse = useThemeLibraryStore.getState();
    expect(afterCollapse.fontLigatures).toBe(beforeCollapse.fontLigatures);
    expect(afterCollapse.panelAnimations).toBe(beforeCollapse.panelAnimations);
    expect(afterCollapse.panelAnimationDuration).toBe(
      beforeCollapse.panelAnimationDuration,
    );
    expect(afterCollapse.contrast).toBe(beforeCollapse.contrast);
  });
});
