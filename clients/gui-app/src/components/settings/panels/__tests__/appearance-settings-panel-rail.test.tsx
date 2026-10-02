import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
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

describe("<AppearanceSettingsPanel /> rail", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createQueryClient();
    useSettingsSearchStore.setState({
      query: "",
      pendingReveal: null,
      handoffPending: false,
    });
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
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

    expect(
      screen.getByRole("tab", { name: "Themes" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(activeTabPanel().getAttribute("aria-label")).toBe("Themes");
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
