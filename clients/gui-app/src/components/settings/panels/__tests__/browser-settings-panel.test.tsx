import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsPanel } from "@/components/settings/panels/browser-settings-panel";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Settings > Browser, rendered the same way as
 * `browser-settings-section-no-host-runtime.test.tsx` (no `<HostRuntimeProvider>`
 * above it): only the `tileBrowser` row's placement-preservation logic is under
 * test here, which has nothing to do with the host-gated website-sessions group.
 */

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: {} }),
}));

vi.mock("@/lib/browser-view/use-browser-save-logins", () => ({
  useBrowserSaveLogins: () => ({
    enabled: true,
    pending: false,
    setEnabled: () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

function choose(control: string, option: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name: control }), {
    key: "ArrowDown",
  });
  const item = screen.getByRole("option", { name: option });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

describe("<BrowserSettingsPanel /> browser placement", () => {
  it("seeds the other categories from the old shared default when switching to per-category", () => {
    useSettingsStore.setState({
      tilePlacement: {
        default: "split",
        content: "split",
        conversation: "split",
        browser: "split",
        sideChat: "split",
      },
    });
    render(<BrowserSettingsPanel />);

    choose("Open browser tabs", "Picture in picture");

    expect(useSettingsStore.getState().tilePlacement).toEqual({
      default: "per-category",
      browser: "pip",
      content: "split",
      conversation: "split",
      sideChat: "split",
    });
  });

  it("writes only the browser field once already per-category, leaving the rest alone", () => {
    useSettingsStore.setState({
      tilePlacement: {
        default: "per-category",
        content: "tab",
        conversation: "split",
        browser: "tab",
        sideChat: "split",
      },
    });
    render(<BrowserSettingsPanel />);

    choose("Open browser tabs", "In a new split");

    expect(useSettingsStore.getState().tilePlacement).toEqual({
      default: "per-category",
      content: "tab",
      conversation: "split",
      browser: "split",
      sideChat: "split",
    });
  });
});

// Moved from opening-behavior-panel.test.tsx - Agent-opened tabs lives on this
// panel now, in its own group alongside Browser placement rather than Links.
describe("<BrowserSettingsPanel /> agent-opened tabs", () => {
  it("writes the surfacing mode", () => {
    render(<BrowserSettingsPanel />);

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("off");

    choose("Agent-opened tabs", "Like any browser tile");

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("surface");
  });

  it("lives in a group of its own, not under Browser placement", () => {
    render(<BrowserSettingsPanel />);

    const control = screen.getByRole("combobox", { name: "Agent-opened tabs" });
    expect(
      screen.getByTestId("settings-opening-agent-tabs").contains(control),
    ).toBe(true);
    expect(
      screen.getByTestId("settings-browser-placement").contains(control),
    ).toBe(false);
  });

  it("stays put when the placement default hides the per-type rows", () => {
    useSettingsStore.setState({
      tilePlacement: {
        default: "tab",
        content: "tab",
        conversation: "tab",
        browser: "split",
        sideChat: "split",
      },
    });
    render(<BrowserSettingsPanel />);

    expect(
      screen.getByRole("combobox", { name: "Agent-opened tabs" }),
    ).not.toBeNull();
  });
});
