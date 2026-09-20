import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSearch } from "@/components/settings/settings-search-box";
import { enterCustomize, exitCustomize } from "@/lib/customize/enter-exit";
import { CUSTOMIZE_LEASE_KEY } from "@/lib/customize/lease";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

// The real entry point, watched: what is asserted is that choosing a result
// calls it, with what.
vi.mock("@/lib/customize/enter-exit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/customize/enter-exit")>();
  return { ...actual, enterCustomize: vi.fn(actual.enterCustomize) };
});

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
  localStorage.clear();
  useSettingsSearchStore.setState({ query: "", pendingReveal: null });
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({
    session: null,
    instances: new Map(),
    lockedBy: "none",
    history: { past: [], future: [] },
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (useCustomizeStore.getState().session) exitCustomize("done");
  cleanup();
  setSystemTabModalApi(null);
  useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  vi.clearAllMocks();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("<SettingsSearch /> launch results", () => {
  it("marks a launch result with the Customize affix", () => {
    render(<Harness />);
    type("microphone");

    const result = screen.getByTestId(
      "settings-search-result-appearance:launch:composer.mic",
    );
    expect(result.textContent).toContain("Microphone");
    expect(result.textContent).toContain("Customize");
    // The breadcrumb names where the control lives.
    expect(result.textContent).toContain("Composer · toolbar");
  });

  it("choosing one enters the editor on the current tab, aimed at the setting", () => {
    render(<Harness />);
    type("microphone");

    fireEvent.click(
      screen.getByTestId(
        "settings-search-result-appearance:launch:composer.mic",
      ),
    );

    expect(enterCustomize).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: "in-place",
        target: "composer.mic",
        source: "direct_ui",
      }),
    );
    expect(useCustomizeStore.getState().session).toMatchObject({
      scene: "in-place",
    });
    expect(useCustomizeStore.getState().pendingTarget).toBe("composer.mic");
    expect(useCustomizeStore.getState().search.query).toBe("Microphone");
    // Nothing navigated and nothing was armed to reveal: the launch is not an
    // anchor.
    expect(navigateToSettingsSectionMock).not.toHaveBeenCalled();
    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
    // The query is spent with the result.
    expect(combobox().value).toBe("");
  });

  it("closes the Settings modal it was chosen in, and remembers where to return", () => {
    const close = vi.fn();
    setSystemTabModalApi({
      active: { kind: "settings", section: "appearance" },
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close,
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => true,
    });
    render(<Harness />);
    type("microphone");

    fireEvent.click(
      screen.getByTestId(
        "settings-search-result-appearance:launch:composer.mic",
      ),
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(useCustomizeStore.getState().session?.opener).toMatchObject({
      kind: "settings-modal",
      section: "appearance",
    });
  });

  it("does nothing visible but explain when another window holds the editor", () => {
    localStorage.setItem(
      CUSTOMIZE_LEASE_KEY,
      JSON.stringify({
        token: "another-window",
        expiresAt: Date.now() + 60000,
      }),
    );
    render(<Harness />);
    type("microphone");

    fireEvent.click(
      screen.getByTestId(
        "settings-search-result-appearance:launch:composer.mic",
      ),
    );

    expect(useCustomizeStore.getState().session).toBeNull();
    expect(toastInfo).toHaveBeenCalledWith(
      "Customize is open in another window.",
    );
    // The reader keeps their search.
    expect(combobox().value).toBe("microphone");
  });

  it("offers no launch result with the editor off, and the old row reveals as before", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    render(<Harness />);
    type("microphone");

    expect(
      screen.queryByTestId(
        "settings-search-result-appearance:launch:composer.mic",
      ),
    ).toBeNull();
    fireEvent.click(
      screen.getByTestId("settings-search-result-layout:layout-composer-mic"),
    );

    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("layout");
    expect(useSettingsSearchStore.getState().pendingReveal).toMatchObject({
      section: "layout",
      anchor: "layout-composer-mic",
    });
    expect(enterCustomize).not.toHaveBeenCalled();
  });
});
