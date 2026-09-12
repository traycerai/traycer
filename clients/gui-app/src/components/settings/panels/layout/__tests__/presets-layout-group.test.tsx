import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresetsLayoutGroup } from "@/components/settings/panels/layout/presets-layout-group";
import { LAYOUT_PRESETS } from "@/lib/layout-presets";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_MINIMAP_SIDE,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
  useSettingsStore,
} from "@/stores/settings/settings-store";

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    trackSettingChanged: vi.fn(actual.trackSettingChanged),
  };
});

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({
    pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
    navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  });
  useLeftPanelStore.setState({
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    panelVisibilityOverrideById: {},
  });
}

beforeEach(resetStores);

afterEach(() => {
  cleanup();
  resetStores();
  vi.clearAllMocks();
});

// The same two-part proof the other Layout group suites rely on: the id the
// click actually fires, through the REAL `trackSettingChanged`, and that id's
// presence in the runtime `ANALYTICS_SETTINGS` allowlist, which is what
// `sanitizeAnalyticsProperties` gates. An id that lives only in the
// `AnalyticsSetting` type drops the event silently.
async function expectSettingIdAccepted(setting: string): Promise<void> {
  const { AnalyticsEvent, sanitizeAnalyticsProperties } =
    await import("@/lib/analytics");
  expect(
    sanitizeAnalyticsProperties(AnalyticsEvent.SettingChanged, {
      source: "direct_ui",
      section: "layout",
      setting,
    }),
  ).toEqual({ source: "direct_ui", section: "layout", setting });
}

const PRESET_DESCRIPTION =
  "Apply one set of detail preferences to every group below. Placement and the sidebar's panel arrangement are left as they are - only Reset restores those. Custom means the current values match no preset.";

function presetGroup(): HTMLElement {
  return screen.getByRole("group", { name: "Layout preset" });
}

function pressed(): ReadonlyArray<string> {
  return within(presetGroup())
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);
}

describe("<PresetsLayoutGroup />", () => {
  it("applies Compact across all three stores and tracks its own id", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<PresetsLayoutGroup />);
    // Applied from the footer placement, which a preset must not move.
    act(() => {
      useLayoutStore.getState().setStatusBarPlacement("status-bar");
    });

    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Compact" }),
    );

    expect(useLayoutStore.getState().statusBar.rateLimits).toEqual(
      LAYOUT_PRESETS.compact.statusBar.rateLimits,
    );
    expect(useLayoutStore.getState().statusBar.resources).toEqual(
      LAYOUT_PRESETS.compact.statusBar.resources,
    );
    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
    expect(pressed()).toEqual(["Compact"]);
    // The bundle's own eight rows, plus the footer's reasoning control left
    // exactly where it was - no bundle carries that one.
    expect(useLayoutStore.getState().composer).toEqual({
      ...LAYOUT_PRESETS.compact.composer,
      reasoningFooterControl: "slider",
    });
    expect(useSettingsStore.getState().contextIndicatorStyle).toBe("ring-only");
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.preset.compact",
    );
    await expectSettingIdAccepted("layout.preset.compact");
  });

  it("applies Detailed and tracks its own id", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<PresetsLayoutGroup />);

    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Detailed" }),
    );

    expect(useLayoutStore.getState().statusBar.rateLimits).toEqual(
      LAYOUT_PRESETS.detailed.statusBar.rateLimits,
    );
    expect(useLayoutStore.getState().statusBar.resources).toEqual(
      LAYOUT_PRESETS.detailed.statusBar.resources,
    );
    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(true);
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "memory",
      "processes",
    ]);
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.preset.detailed",
    );
    await expectSettingIdAccepted("layout.preset.detailed");
  });

  it("presses the segment the stores currently match, and moves with them", () => {
    render(<PresetsLayoutGroup />);
    expect(pressed()).toEqual(["Default"]);

    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Detailed" }),
    );
    expect(pressed()).toEqual(["Detailed"]);

    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Compact" }),
    );
    expect(pressed()).toEqual(["Compact"]);
  });

  it("shows Custom, pressing nothing, as soon as a row below is changed", () => {
    render(<PresetsLayoutGroup />);
    expect(screen.queryByTestId("layout-preset-custom")).toBeNull();

    // A row the user could flip on this page, written through the store the
    // row writes - the control is derived, so no remount is involved.
    act(() => {
      useSettingsStore.getState().setContextIndicatorStyle("ring");
    });

    expect(screen.getByTestId("layout-preset-custom").textContent).toBe(
      "Custom",
    );
    expect(pressed()).toEqual([]);
    // And back again the moment the value returns.
    act(() => {
      useSettingsStore
        .getState()
        .setContextIndicatorStyle(DEFAULT_CONTEXT_INDICATOR_STYLE);
    });
    expect(screen.queryByTestId("layout-preset-custom")).toBeNull();
    expect(pressed()).toEqual(["Default"]);
  });

  it("resets to defaults from Compact - placement and panels included - and tracks the default id", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    render(<PresetsLayoutGroup />);
    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Compact" }),
    );
    act(() => {
      useLayoutStore.getState().setStatusBarPlacement("header");
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("terminals", false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    // Reset is the one caller that restores the structural pair too: the
    // placement the strip lives in, and the rail below.
    expect(useLayoutStore.getState().statusBar).toEqual(
      DEFAULT_STATUS_BAR_LAYOUT,
    );
    expect(useLayoutStore.getState().composer).toEqual(DEFAULT_COMPOSER_LAYOUT);
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual(
      DEFAULT_NAVIGATOR_RESOURCE_METRICS,
    );
    expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual(
      {},
    );
    expect(pressed()).toEqual(["Default"]);
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.preset.default",
    );
    await expectSettingIdAccepted("layout.preset.default");
  });

  it("disables Reset only while the WHOLE page is already the default one", () => {
    render(<PresetsLayoutGroup />);
    const reset = () =>
      screen.getByRole("button", { name: "Reset to defaults" });
    expect(reset().hasAttribute("disabled")).toBe(true);

    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Compact" }),
    );
    expect(reset().hasAttribute("disabled")).toBe(false);

    // Back on the Default bundle, but with a moved strip and a rearranged
    // rail - neither of which the bundle carries, and both of which Reset
    // still has to undo.
    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Default" }),
    );
    expect(pressed()).toEqual(["Default"]);
    expect(reset().hasAttribute("disabled")).toBe(true);

    act(() => {
      useLayoutStore.getState().setStatusBarPlacement("header");
    });
    expect(pressed()).toEqual(["Default"]);
    expect(reset().hasAttribute("disabled")).toBe(false);

    act(() => {
      useLayoutStore.getState().setStatusBarPlacement("status-bar");
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("terminals", false);
    });
    expect(reset().hasAttribute("disabled")).toBe(false);
  });

  it("keeps Reset live for a page whose only change is the mobile footer", () => {
    // The third structural setting, and the one with no segment of its own:
    // `matchLayoutPreset` does not read `mobileFooter`, so `match` stays
    // `default` - while `resetLayoutToDefaults` DOES restore it. Left out of
    // the predicate, Reset went dead on the one setting it still had to undo.
    render(<PresetsLayoutGroup />);
    const reset = () =>
      screen.getByRole("button", { name: "Reset to defaults" });
    expect(reset().hasAttribute("disabled")).toBe(true);

    act(() => {
      useLayoutStore.getState().setStatusBarMobileFooter(true);
    });

    expect(pressed()).toEqual(["Default"]);
    expect(reset().hasAttribute("disabled")).toBe(false);

    fireEvent.click(reset());

    expect(useLayoutStore.getState().statusBar.mobileFooter).toBe(false);
    expect(reset().hasAttribute("disabled")).toBe(true);
  });

  it("leaves placement and the rail where they are when Default is picked", () => {
    // The segment is the density bundle; only the button is the whole page.
    render(<PresetsLayoutGroup />);
    act(() => {
      // Off the default placement, so a bundle that wrote one would show up
      // here rather than coincide with it.
      useLayoutStore.getState().setStatusBarPlacement("header");
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("terminals", false);
    });
    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Compact" }),
    );

    fireEvent.click(
      within(presetGroup()).getByRole("button", { name: "Default" }),
    );

    expect(pressed()).toEqual(["Default"]);
    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
    expect(
      useLeftPanelStore.getState().panelVisibilityOverrideById.terminals,
    ).toBe(false);
  });

  it("carries the anchors settings search scrolls to, with the row's own copy", () => {
    const { container } = render(<PresetsLayoutGroup />);
    expect(
      container.querySelector("[data-settings-anchor='layout-presets']"),
    ).not.toBeNull();
    const row = container.querySelector(
      "[data-settings-anchor='layout-presets-choice']",
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Preset");
    expect(row?.textContent).toContain(PRESET_DESCRIPTION);
  });

  // The index is hand-written, so the label and description are what rot - the
  // anchor half is covered by `settings-search-index.test.ts`.
  it("is indexed as a group and a row, with the verbatim copy", () => {
    const group = SETTINGS_SEARCH_ENTRIES.find(
      (candidate) => candidate.anchor === "layout-presets",
    );
    expect(group?.kind).toBe("group");
    expect(group?.section).toBe("layout");
    expect(group?.label).toBe("Presets");

    const row = SETTINGS_SEARCH_ENTRIES.find(
      (candidate) => candidate.anchor === "layout-presets-choice",
    );
    expect(row?.kind).toBe("setting");
    expect(row?.group).toBe("Presets");
    expect(row?.label).toBe("Preset");
    expect(row?.description).toBe(PRESET_DESCRIPTION);
    for (const keyword of [
      "preset",
      "compact",
      "detailed",
      "reset",
      "defaults",
    ]) {
      expect(row?.keywords).toContain(keyword);
      expect(group?.keywords).toContain(keyword);
    }
  });
});
