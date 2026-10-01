import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { SettingsSearch } from "@/components/settings/settings-search-box";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
const openLayoutEditorMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

// The door itself is `editor-session`'s own suite; what this one asks is that a
// launch result goes THROUGH it rather than scrolling a settings page.
vi.mock("@/lib/layout/editor-session", () => ({
  openLayoutEditor: openLayoutEditorMock,
}));

function Harness(): ReactNode {
  const [query, setQuery] = useState("");
  return <SettingsSearch query={query} onQueryChange={setQuery} />;
}

function combobox(): HTMLInputElement {
  const input = screen.getByRole("combobox", { name: "Search settings" });
  if (!(input instanceof HTMLInputElement)) throw new Error("not an input");
  return input;
}

function type(query: string): void {
  fireEvent.change(combobox(), { target: { value: query } });
}

beforeEach(() => {
  useSettingsSearchStore.setState({ query: "", pendingReveal: null });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  setSystemTabModalApi(null);
  vi.clearAllMocks();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

/**
 * A launch result is a piece of the app's chrome, not a row on a page: it
 * wears a "Layout" badge and it opens the editor on that region (L-07, 5.3).
 * The width gate belongs to the door, so nothing here asks about it.
 */
describe("<SettingsSearch /> launch results", () => {
  it("marks a launch result with the Layout badge", () => {
    render(<Harness />);
    type("microphone");

    const result = screen.getByTestId(
      "settings-search-result-layout:launch:mic",
    );
    expect(result.textContent).toContain("Microphone");
    expect(result.textContent).toContain("Layout");
  });

  it("clicking one opens the editor on that region, and reveals no settings row", () => {
    render(<Harness />);
    type("microphone");

    fireEvent.click(
      screen.getByTestId("settings-search-result-layout:launch:mic"),
    );

    expect(openLayoutEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "direct_ui",
        entry: "pointer",
        target: "mic",
        // The region's own area, so leaving the editor returns there.
        origin: { kind: "settings", area: LAYOUT_REGIONS.mic.surface },
      }),
    );
    expect(navigateToSettingsSectionMock).not.toHaveBeenCalled();
    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
  });

  // The entry method gates the editor's entry motion as well as being reported
  // (L-30, L-54), so the two ways of choosing a result must not both claim a
  // pointer.
  it("reports the keyboard when the result is chosen with Enter", () => {
    render(<Harness />);
    type("microphone");
    fireEvent.keyDown(combobox(), { key: "Enter" });

    expect(openLayoutEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ entry: "keyboard", target: "mic" }),
    );
  });

  it("leaves an ordinary result on the settings path", () => {
    render(<Harness />);
    type("interface font");

    fireEvent.click(
      screen.getByTestId(
        "settings-search-result-appearance:appearance-ui-font",
      ),
    );

    expect(openLayoutEditorMock).not.toHaveBeenCalled();
    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("appearance");
  });
});
