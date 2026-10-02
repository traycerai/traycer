import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));

const AREA_LABELS = [
  "Themes",
  "Start page",
  "Interface",
  "Fonts and text",
  "Terminal",
  "Diff viewer",
  "Tasks",
] as const;

const AREA_IDS = [
  "themes",
  "startPage",
  "interface",
  "typography",
  "terminal",
  "diffViewer",
  "tasks",
] as const;

function resetOnboarding(): void {
  useOnboardingStore.setState({
    setupProgress: { agents: -1, appearance: -1, cookies: -1 },
    activeSetup: null,
  });
}

describe("<AppearanceSettingsPanel /> rail", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createQueryClient();
    resetOnboarding();
    useSettingsSearchStore.setState({
      query: "",
      pendingReveal: null,
      handoffPending: false,
    });
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    resetOnboarding();
    useSettingsSearchStore.setState({
      query: "",
      pendingReveal: null,
      handoffPending: false,
    });
  });

  it("lists the seven appearance areas in order, with Themes picked first", () => {
    renderPanel(queryClient);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([...AREA_LABELS]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(activeTabPanel().getAttribute("aria-label")).toBe("Themes");
    expect(
      document.querySelectorAll('[role="tabpanel"]:not([hidden])'),
    ).toHaveLength(1);
  });

  it("shows the picked area's panel, hides the others, and keeps every area mounted", async () => {
    const user = userEvent.setup();
    renderPanel(queryClient);

    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(
      AREA_LABELS.length,
    );

    await user.click(screen.getByRole("tab", { name: "Interface" }));

    expect(
      document.querySelectorAll('[role="tabpanel"]:not([hidden])'),
    ).toHaveLength(1);
    expect(activeTabPanel().getAttribute("aria-label")).toBe("Interface");
    expect(
      screen
        .getByRole("tab", { name: "Interface" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Themes" }).getAttribute("aria-selected"),
    ).toBe("false");

    for (const label of AREA_LABELS) {
      const panel = areaPanel(label);
      expect(panel.hasAttribute("hidden")).toBe(label !== "Interface");
    }
  });

  it("draws no group heading inside an area", async () => {
    const user = userEvent.setup();
    renderPanel(queryClient);

    for (const label of AREA_LABELS) {
      await user.click(screen.getByRole("tab", { name: label }));
      expect(
        within(activeTabPanel()).queryByRole("heading", { level: 2 }),
      ).toBeNull();
    }
  });

  it("keeps the three motion rows inside the Interface area", async () => {
    const user = userEvent.setup();
    renderPanel(queryClient);
    await user.click(screen.getByRole("tab", { name: "Interface" }));

    const panel = activeTabPanel();
    expect(within(panel).getByText("Panel animations")).toBeTruthy();
    expect(within(panel).getByText("Animation duration")).toBeTruthy();
    expect(within(panel).getByText("Text and border contrast")).toBeTruthy();
    expect(
      areaPanel("Fonts and text").contains(
        screen.getByText("Panel animations"),
      ),
    ).toBe(false);
  });

  it("holds Agent office default view and Color icons by type in the Tasks area", async () => {
    const user = userEvent.setup();
    renderPanel(queryClient);
    await user.click(screen.getByRole("tab", { name: "Tasks" }));

    const panel = activeTabPanel();
    expect(within(panel).getByText("Agent office default view")).toBeTruthy();
    expect(
      within(panel).getByRole("switch", { name: "Color icons by type" }),
    ).toBeTruthy();
    expect(
      within(panel).getByRole("combobox", {
        name: "Agent office default view",
      }),
    ).toBeTruthy();
  });

  it("picks an Appearance row's area from a pending settings-search reveal", () => {
    useSettingsSearchStore
      .getState()
      .requestReveal(
        "appearance",
        APPEARANCE.definitions.panelAnimations.anchor,
      );

    renderPanel(queryClient);

    expect(
      screen
        .getByRole("tab", { name: "Interface" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(activeTabPanel().getAttribute("aria-label")).toBe("Interface");
    expect(within(activeTabPanel()).getByText("Panel animations")).toBeTruthy();
  });

  it("leaves the picked area on Themes when the reveal is for another section", () => {
    useSettingsSearchStore
      .getState()
      .requestReveal("layout", APPEARANCE.definitions.panelAnimations.anchor);

    renderPanel(queryClient);

    expectArea("Themes");
  });

  it("picks the Start page area from a pending reveal of the Start page group anchor", () => {
    useSettingsSearchStore
      .getState()
      .requestReveal("appearance", APPEARANCE.definitions.startPage.anchor);

    renderPanel(queryClient);

    expectArea("Start page");
  });

  it("names every tab panel with its area id", () => {
    renderPanel(queryClient);

    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    expect(
      panels.map((panel) => panel.getAttribute("data-settings-area")),
    ).toEqual([...AREA_IDS]);
  });

  describe("setup guide area pick", () => {
    it("shows Start page when the appearance guide is on step 1", () => {
      useOnboardingStore.getState().startSetup("appearance");
      useOnboardingStore.getState().advanceSetup();
      renderPanel(queryClient);

      expectArea("Start page");
    });

    it("shows Fonts and text when the appearance guide is on step 2", () => {
      useOnboardingStore.getState().startSetup("appearance");
      useOnboardingStore.getState().advanceSetup();
      useOnboardingStore.getState().advanceSetup();
      renderPanel(queryClient);

      expectArea("Fonts and text");
    });

    it("shows Themes when the appearance guide is on step 0", () => {
      useOnboardingStore.getState().startSetup("appearance");
      renderPanel(queryClient);

      expectArea("Themes");
    });

    it("moves the area when the mounted guide advances", () => {
      useOnboardingStore.getState().startSetup("appearance");
      renderPanel(queryClient);
      expectArea("Themes");

      act(() => {
        useOnboardingStore.getState().advanceSetup();
      });

      expectArea("Start page");
    });

    it("leaves a hand-picked area where the person put it while a step is active", async () => {
      const user = userEvent.setup();
      useOnboardingStore.getState().startSetup("appearance");
      renderPanel(queryClient);
      expectArea("Themes");

      await user.click(screen.getByRole("tab", { name: "Interface" }));

      expectArea("Interface");
    });

    it("leaves the area on Themes when the guide step is on another section", () => {
      useOnboardingStore.getState().startSetup("appearance");
      useOnboardingStore.getState().advanceSetup();
      useOnboardingStore.getState().advanceSetup();
      useOnboardingStore.getState().advanceSetup();
      renderPanel(queryClient);

      expect(useOnboardingStore.getState().activeSetup).toEqual({
        id: "appearance",
        step: 3,
      });
      expectArea("Themes");
    });

    it("leaves the area on Themes when a different guide is active", () => {
      useOnboardingStore.getState().startSetup("agents");
      renderPanel(queryClient);

      expectArea("Themes");
    });
  });
});

function areaPanel(label: (typeof AREA_LABELS)[number]): HTMLElement {
  const panel = document.querySelector(
    `[role="tabpanel"][aria-label="${label}"]`,
  );
  if (!(panel instanceof HTMLElement)) {
    throw new Error(`no tabpanel for ${label}`);
  }
  return panel;
}

function activeTabPanel(): HTMLElement {
  const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
  if (!(panel instanceof HTMLElement)) throw new Error("no active tabpanel");
  return panel;
}

function expectArea(label: (typeof AREA_LABELS)[number]): void {
  expect(
    screen.getByRole("tab", { name: label }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(activeTabPanel().getAttribute("aria-label")).toBe(label);
  expect(activeTabPanel().hasAttribute("hidden")).toBe(false);
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPanel(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <AppearanceSettingsPanel />
    </QueryClientProvider>,
  );
}
