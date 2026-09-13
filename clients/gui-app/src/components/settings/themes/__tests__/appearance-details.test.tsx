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
    version: 2,
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

describe("AppearanceDetails motion and readability", () => {
  it("keeps motion and readability controls visible and gates duration on animations", () => {
    render(<AppearanceDetails />);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Motion and readability",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Advanced options" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Use font ligatures" }),
    ).toBeNull();
    expect(screen.queryByText("Prompt font")).toBeNull();

    const animations = screen.getByRole("switch", { name: "Panel animations" });
    const duration = screen.getByLabelText("Animation duration");
    expect(duration.matches(":disabled")).toBe(false);
    expect(screen.getByLabelText("Text and border contrast")).toBeTruthy();

    fireEvent.click(animations);

    const durationFieldset = duration.closest("fieldset");
    expect(durationFieldset).not.toBeNull();
    expect((durationFieldset as HTMLFieldSetElement).disabled).toBe(true);
    expect(useThemeLibraryStore.getState().panelAnimations).toBe(false);
  });
});
