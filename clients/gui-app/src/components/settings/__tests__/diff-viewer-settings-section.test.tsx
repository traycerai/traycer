import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffViewerSettingsSection } from "@/components/settings/diff-viewer-settings-section";
import {
  DEFAULT_DIFF_VIEWER_PREFERENCES,
  type DiffViewerPreferences,
} from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

function renderSection(): void {
  render(<DiffViewerSettingsSection />);
}

function rowLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".font-medium.text-foreground"),
    (node) => node.textContent,
  );
}

function setPreferences(patch: Partial<DiffViewerPreferences>): void {
  useSettingsStore.setState((s) => ({
    diffViewerPreferences: { ...s.diffViewerPreferences, ...patch },
  }));
}

function resetPreferences(): void {
  useSettingsStore.setState({
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
  });
}

describe("DiffViewerSettingsSection", () => {
  beforeEach(() => {
    resetPreferences();
  });

  afterEach(() => {
    cleanup();
    resetPreferences();
  });

  it("renders every Diff viewer row in order without a group heading", () => {
    renderSection();

    expect(
      screen.queryByRole("heading", { level: 2, name: "Diff viewer" }),
    ).toBeNull();
    expect(rowLabels()).toEqual([
      "Layout",
      "Line numbers",
      "Backgrounds",
      "Gutter marks",
      "Word wrap",
      "Ignore whitespace",
    ]);
  });

  it("reflects a pre-set store value in the pressed segment and checked switches", () => {
    setPreferences({
      mode: "unified",
      indicatorStyle: "classic",
      lineNumbers: false,
      backgrounds: false,
      wordWrap: true,
      ignoreWhitespace: true,
    });
    renderSection();

    const layoutGroup = screen.getByRole("group", { name: "Diff layout" });
    expect(
      within(layoutGroup)
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(layoutGroup)
        .getByRole("button", { name: "Split" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    const gutterGroup = screen.getByRole("group", { name: "Gutter marks" });
    expect(
      within(gutterGroup)
        .getByRole("button", { name: "Plus / minus" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    expect(
      screen
        .getByRole("switch", { name: "Line numbers" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "Backgrounds" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "Word wrap" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "Ignore whitespace" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("patches the store when a switch is toggled", () => {
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: "Line numbers" }));
    expect(useSettingsStore.getState().diffViewerPreferences.lineNumbers).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Backgrounds" }));
    expect(useSettingsStore.getState().diffViewerPreferences.backgrounds).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Word wrap" }));
    expect(useSettingsStore.getState().diffViewerPreferences.wordWrap).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Ignore whitespace" }));
    expect(
      useSettingsStore.getState().diffViewerPreferences.ignoreWhitespace,
    ).toBe(true);
  });

  it("patches the store when a segmented option is picked", () => {
    renderSection();

    fireEvent.click(
      within(screen.getByRole("group", { name: "Diff layout" })).getByRole(
        "button",
        { name: "Unified" },
      ),
    );
    expect(useSettingsStore.getState().diffViewerPreferences.mode).toBe(
      "unified",
    );

    fireEvent.click(
      within(screen.getByRole("group", { name: "Gutter marks" })).getByRole(
        "button",
        { name: "Hidden" },
      ),
    );
    expect(
      useSettingsStore.getState().diffViewerPreferences.indicatorStyle,
    ).toBe("none");
  });

  it("re-renders when the store changes elsewhere, as the diff tile popover would", () => {
    renderSection();
    expect(
      screen
        .getByRole("switch", { name: "Line numbers" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(screen.getByRole("group", { name: "Diff layout" }))
        .getByRole("button", { name: "Split" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    act(() => {
      setPreferences({ lineNumbers: false, mode: "unified" });
    });

    expect(
      screen
        .getByRole("switch", { name: "Line numbers" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      within(screen.getByRole("group", { name: "Diff layout" }))
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
