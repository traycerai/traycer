import type { NavigateFn } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { activateTabIntent } from "@/lib/tab-navigation";
import { exitCustomize } from "@/lib/customize/enter-exit";
import { CUSTOMIZE_LEASE_KEY } from "@/lib/customize/lease";
import { matchLayoutPreset } from "@/lib/layout-presets";
import { useCustomizeStore } from "@/stores/customize/customize-store";
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
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

// Only the navigation entry point is replaced; the rest of the module stays
// real so the sample tab is materialised in the real tabs store.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: vi.fn(() => true),
}));

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    trackSettingChanged: vi.fn(actual.trackSettingChanged),
  };
});

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));

function resetStores(): void {
  localStorage.clear();
  useSettingsStore.setState({
    visualLayoutEditorEnabled: false,
    pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
    navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  });
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useLeftPanelStore.setState({
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    panelVisibilityOverrideById: {},
  });
  useCustomizeStore.setState({
    session: null,
    instances: new Map(),
    lockedBy: "none",
    history: { past: [], future: [] },
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
}

function sampleItemCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppearanceSettingsPanel />
    </QueryClientProvider>,
  );
}

function switchRow(): HTMLElement {
  return screen.getByRole("switch", { name: "Visual layout editor" });
}

beforeEach(() => {
  resetStores();
  navigate.mockReset();
  vi.mocked(activateTabIntent).mockClear();
});

afterEach(() => {
  if (useCustomizeStore.getState().session) exitCustomize("done");
  cleanup();
  resetStores();
  vi.clearAllMocks();
});

describe("Appearance ▸ Layout group", () => {
  it("draws only the switch row while the editor is off", () => {
    renderPanel();

    expect(
      screen.getByRole("heading", { level: 2, name: "Layout" }),
    ).toBeTruthy();
    expect(switchRow().getAttribute("aria-checked")).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Customize layout" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open sample workspace" }),
    ).toBeNull();
    expect(
      screen.queryByRole("radiogroup", { name: "Layout preset" }),
    ).toBeNull();
  });

  it("the switch writes the store and brings the card and presets in and out", () => {
    renderPanel();

    fireEvent.click(switchRow());

    expect(useSettingsStore.getState().visualLayoutEditorEnabled).toBe(true);
    expect(
      screen.getByRole("button", { name: "Customize layout" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open sample workspace" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Layout preset" }),
    ).toBeTruthy();

    fireEvent.click(switchRow());

    expect(useSettingsStore.getState().visualLayoutEditorEnabled).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Customize layout" }),
    ).toBeNull();
    expect(
      screen.queryByRole("radiogroup", { name: "Layout preset" }),
    ).toBeNull();
  });

  it("stays a single switch row at a window narrower than the editor supports", () => {
    Object.defineProperty(window, "innerWidth", {
      value: 500,
      configurable: true,
      writable: true,
    });
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    try {
      renderPanel();

      expect(switchRow().getAttribute("aria-checked")).toBe("true");
      expect(
        screen.queryByRole("button", { name: "Customize layout" }),
      ).toBeNull();
      expect(
        screen.queryByRole("radiogroup", { name: "Layout preset" }),
      ).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        value: 1024,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("Appearance ▸ Layout card", () => {
  beforeEach(() => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  });

  it("Customize layout starts the in-place editor through the shared action", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Customize layout" }));

    expect(useCustomizeStore.getState().session).toMatchObject({
      scene: "in-place",
    });
  });

  it("Open sample workspace runs the shared action with the router's navigate", () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Open sample workspace" }),
    );

    expect(sampleItemCount()).toBe(1);
    const navigateFn: NavigateFn = navigate;
    expect(activateTabIntent).toHaveBeenCalledWith(
      navigateFn,
      { kind: "sample-workspace" },
      undefined,
    );
    // The card never enters a session itself: the sample surface owns that.
    expect(useCustomizeStore.getState().session).toBeNull();
  });

  it("says another window is customizing and disables both buttons", () => {
    localStorage.setItem(
      CUSTOMIZE_LEASE_KEY,
      JSON.stringify({
        token: "another-window",
        expiresAt: Date.now() + 60000,
      }),
    );

    renderPanel();

    const customize = screen.getByRole("button", { name: "Customize layout" });
    expect(customize.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Open sample workspace" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      customize
        .closest("[data-settings-anchor]")
        ?.querySelector("[role='status']")?.textContent,
    ).toContain("another window");
    fireEvent.click(customize);
    expect(useCustomizeStore.getState().session).toBeNull();
  });

  it("keeps the picture out of the accessibility tree and the buttons live", () => {
    renderPanel();

    const card = screen
      .getByRole("button", { name: "Customize layout" })
      .closest("[data-settings-anchor]");
    expect(card).not.toBeNull();
    const pictures = card?.querySelectorAll("[inert][aria-hidden='true']");
    expect(pictures?.length).toBe(1);
    // Neither live button sits inside the inert picture.
    for (const name of ["Customize layout", "Open sample workspace"]) {
      expect(
        pictures?.[0]?.contains(screen.getByRole("button", { name })),
      ).toBe(false);
    }
  });
});

describe("Appearance ▸ Layout presets", () => {
  beforeEach(() => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  });

  function presetGroup(): HTMLElement {
    return screen.getByRole("radiogroup", { name: "Layout preset" });
  }

  it("draws each preset with its name, one-line description and a picture", () => {
    renderPanel();

    for (const name of ["Default", "Compact", "Detailed"]) {
      const option = within(presetGroup()).getByRole("radio", { name });
      const label = option.closest("label");
      expect(label?.textContent).toContain(name);
      expect(
        label?.querySelectorAll("[inert][aria-hidden='true']").length,
      ).toBe(1);
    }
    expect(
      within(presetGroup())
        .getByRole("radio", { name: "Default" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("choosing Compact applies the bundle and reports the id", async () => {
    const { trackSettingChanged } = await import("@/lib/analytics");
    renderPanel();

    fireEvent.click(
      within(presetGroup()).getByRole("radio", { name: "Compact" }),
    );

    expect(useLayoutStore.getState().composer.filesChanged).toBe("compact");
    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    expect(
      within(presetGroup())
        .getByRole("radio", { name: "Compact" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.preset.compact",
    );
    expect(screen.queryByTestId("layout-preset-custom")).toBeNull();
  });

  it("agrees with the verdict the rest of the app derives", () => {
    renderPanel();

    fireEvent.click(
      within(presetGroup()).getByRole("radio", { name: "Detailed" }),
    );

    expect(
      matchLayoutPreset({
        statusBar: useLayoutStore.getState().statusBar,
        composer: useLayoutStore.getState().composer,
        chat: {
          pinContextUsageBreakdown:
            useSettingsStore.getState().pinContextUsageBreakdown,
          pinnedContextBreakdownFields:
            useSettingsStore.getState().pinnedContextBreakdownFields,
          contextIndicatorStyle:
            useSettingsStore.getState().contextIndicatorStyle,
          chatTurnMinimapSide: useSettingsStore.getState().chatTurnMinimapSide,
        },
        sidebar: {
          navigatorResourceMetrics:
            useSettingsStore.getState().navigatorResourceMetrics,
        },
      }),
    ).toBe("detailed");
  });

  it("an edit that matches no preset leaves none checked and shows Custom", () => {
    renderPanel();

    act(() => {
      useLayoutStore.getState().setComposerMic("hidden");
    });

    expect(screen.getByTestId("layout-preset-custom")).toBeTruthy();
    for (const radio of within(presetGroup()).getAllByRole("radio")) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("Reset stays enabled after an order-only change and restores it", () => {
    renderPanel();
    const reset = screen.getByRole("button", { name: "Reset to defaults" });
    expect(reset.hasAttribute("disabled")).toBe(true);

    act(() => {
      useLayoutStore
        .getState()
        .setComposerDockOrder(["background", "activeAgents", "filesChanged"]);
    });

    // The verdict is still Default - an order is no preset's business - which
    // is exactly why Reset must not go dead here.
    expect(
      within(presetGroup())
        .getByRole("radio", { name: "Default" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(reset.hasAttribute("disabled")).toBe(false);

    fireEvent.click(reset);

    expect(useLayoutStore.getState().composer.dockOrder).toEqual(
      DEFAULT_COMPOSER_LAYOUT.dockOrder,
    );
    expect(reset.hasAttribute("disabled")).toBe(true);
  });
});

/** Mounts a real registering leaf, the control the assertions below need. */
function RegisteringControl(): React.ReactNode {
  const { ref } = useLayoutHotspot({
    settingId: "composer.attachImage",
    tileId: null,
    ghost: false,
    condition: null,
  });
  return <div ref={ref}>control</div>;
}

describe("Appearance ▸ Layout registers no hotspot during a session", () => {
  it("mounting the page while Customize runs registers zero instances", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    useCustomizeStore.setState({
      session: {
        scene: "in-place",
        opener: {
          kind: "settings-tab",
          tabId: "settings",
          section: "appearance",
          scrollTop: 0,
        },
        startedAt: Date.now(),
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AppearanceSettingsPanel />
        <RegisteringControl />
      </QueryClientProvider>,
    );

    // The card and every preset thumbnail are mounted...
    expect(
      screen.getByRole("radiogroup", { name: "Layout preset" }),
    ).toBeTruthy();
    // ...and the ONLY registration is the positive control, so the check is not
    // vacuous and no picture leaf registered an unreachable hotspot.
    const registered = [...useCustomizeStore.getState().instances.values()];
    expect(registered).toHaveLength(1);
    expect(registered[0]?.node.textContent).toBe("control");
  });
});
