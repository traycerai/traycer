import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import {
  buildFontFamilyValue,
  DEFAULT_MONO_FONT_STACK,
} from "@/lib/default-font-stacks";
import {
  DEFAULT_AGENT_OFFICE_VIEW,
  DEFAULT_CODE_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { OFFICE_VIEW_LABELS } from "@/lib/comm-graph/office/office-view-vocabulary";

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

// The Start page group's wallpaper gallery fetches its catalog from the CDN.
// An empty catalog keeps this suite off the network without changing which
// rows - and so which search anchors - the panel renders.
vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));

function resetAppearanceSettings(): void {
  useSettingsStore.setState({
    artifactIconColorMode: "byType",
    artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
    pointerCursors: true,
    codeFontFamily: null,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    terminalFontFamily: null,
    terminalFontSize: null,
    agentOfficeDefaultView: DEFAULT_AGENT_OFFICE_VIEW,
  });
}

describe("<AppearanceSettingsPanel /> groups", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createQueryClient();
    resetAppearanceSettings();
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    resetAppearanceSettings();
  });

  it("renders the Agent office default view row in the Tasks area, wired to the store", async () => {
    renderPanel(queryClient);
    await goToArea("Tasks");

    const panel = activeTabPanel();
    expect(panel.getAttribute("aria-label")).toBe("Tasks");
    expect(within(panel).getByText("Agent office default view")).toBeTruthy();
    expect(
      within(panel).getByRole("switch", { name: "Color icons by type" }),
    ).toBeTruthy();

    const select = screen.getByRole("combobox", {
      name: "Agent office default view",
    });
    expect(select.textContent).toBe(
      OFFICE_VIEW_LABELS[DEFAULT_AGENT_OFFICE_VIEW],
    );

    fireEvent.click(select);
    fireEvent.click(
      // Sourced from the leaf vocabulary module, not the registry: the panel
      // itself now reads `OFFICE_VIEW_LABELS`, so this proves the option text
      // it actually renders, without importing every planner, measurer and
      // painter the registry pulls in.
      screen.getByRole("option", { name: OFFICE_VIEW_LABELS.floor }),
    );

    expect(useSettingsStore.getState().agentOfficeDefaultView).toBe("floor");
  });

  it("sizes the Agent office default view selector as a fluid width with a tokenized cap (Finding 16)", async () => {
    // A fixed `w-[min(40vw,8rem)]` caps a new layout surface at an arbitrary
    // rem, which the GUI fluid-sizing rule forbids - `w-[40vw]` (fluid)
    // plus a tokenized `max-w-32` ceiling replaces it. Scoped to the
    // Agent office default view trigger only: "Display zoom" carries the same
    // `w-[min(40vw,8rem)]` shape and is deliberately out of scope here.
    renderPanel(queryClient);
    await goToArea("Tasks");

    const select = screen.getByRole("combobox", {
      name: "Agent office default view",
    });
    expect(select.className).toContain("w-[40vw]");
    expect(select.className).toContain("max-w-32");
    expect(select.className).not.toContain("w-[min(40vw,8rem)]");
  });

  // The minimap side control moved to Settings > Layout's Chat group, where it
  // sits with the other message-pane placement controls; its `settings-store`
  // key is unchanged.
  it("no longer renders the minimap side control", () => {
    renderPanel(queryClient);

    expect(
      screen.queryByRole("combobox", { name: "Minimap position" }),
    ).toBeNull();
  });

  it("places representative rows in the area that names them, sharing a card per area", () => {
    renderPanel(queryClient);

    const schemeButton = screen.getByRole("button", { name: "Follow device" });
    const preset = screen.getByRole("button", { name: "Light theme" });
    const pointerCursors = screen.getByText(
      "Show a hand cursor over clickable controls",
    );
    const interfaceFont = screen.getByText("Interface font");
    const codeFont = screen.getByText("Code font");
    const promptFont = screen.getByText("Prompt font");
    const fontLigatures = screen.getByText("Use font ligatures");
    const panelAnimations = screen.getByText("Panel animations");
    const animationDuration = screen.getByText("Animation duration");
    const textContrast = screen.getByText("Text and border contrast");
    const terminalFont = screen.getByText("Terminal font");
    const terminalCursor = screen.getByText("Terminal cursor");
    const blinkCursor = screen.getByText("Blink cursor");
    const artifactIconColors = screen.getAllByText("Color icons by type")[0];

    expect(areaPanel("Themes").contains(schemeButton)).toBe(true);
    expect(areaPanel("Themes").contains(preset)).toBe(true);
    expect(schemeButton.closest("div.rounded-lg")).toBe(
      preset.closest("div.rounded-lg"),
    );

    expect(areaPanel("Interface").contains(pointerCursors)).toBe(true);
    expect(areaPanel("Interface").contains(panelAnimations)).toBe(true);
    expect(areaPanel("Interface").contains(animationDuration)).toBe(true);
    expect(areaPanel("Interface").contains(textContrast)).toBe(true);
    expect(pointerCursors.closest("div.rounded-lg")).toBe(
      panelAnimations.closest("div.rounded-lg"),
    );

    expect(areaPanel("Fonts and text").contains(interfaceFont)).toBe(true);
    expect(areaPanel("Fonts and text").contains(codeFont)).toBe(true);
    expect(areaPanel("Fonts and text").contains(promptFont)).toBe(true);
    expect(areaPanel("Fonts and text").contains(fontLigatures)).toBe(true);
    expect(interfaceFont.closest("div.rounded-lg")).toBe(
      codeFont.closest("div.rounded-lg"),
    );
    expect(promptFont.closest("div.rounded-lg")).toBe(
      interfaceFont.closest("div.rounded-lg"),
    );
    expect(fontLigatures.closest("div.rounded-lg")).toBe(
      interfaceFont.closest("div.rounded-lg"),
    );

    expect(areaPanel("Terminal").contains(terminalFont)).toBe(true);
    expect(areaPanel("Terminal").contains(terminalCursor)).toBe(true);
    expect(areaPanel("Terminal").contains(blinkCursor)).toBe(true);
    expect(terminalFont.closest("div.rounded-lg")).toBe(
      terminalCursor.closest("div.rounded-lg"),
    );
    expect(terminalCursor.closest("div.rounded-lg")).toBe(
      blinkCursor.closest("div.rounded-lg"),
    );

    expect(areaPanel("Tasks").contains(artifactIconColors)).toBe(true);

    // Rows from different areas do NOT share a card.
    expect(preset.closest("div.rounded-lg")).not.toBe(
      pointerCursors.closest("div.rounded-lg"),
    );
    expect(pointerCursors.closest("div.rounded-lg")).not.toBe(
      interfaceFont.closest("div.rounded-lg"),
    );
    expect(interfaceFont.closest("div.rounded-lg")).not.toBe(
      terminalFont.closest("div.rounded-lg"),
    );
    expect(terminalFont.closest("div.rounded-lg")).not.toBe(
      artifactIconColors.closest("div.rounded-lg"),
    );
  });

  it("renders the terminal preview inside the Terminal card without a row label", async () => {
    renderPanel(queryClient);
    await goToArea("Terminal");

    const terminalFont = screen.getByText("Terminal font");
    const terminalCursor = screen.getByText("Terminal cursor");
    const blinkCursor = screen.getByText("Blink cursor");
    const previewPrompt = screen.getByText("git status");

    // No labeled "Terminal preview" row - the decorative preview sits bare in
    // the card next to the terminal controls.
    expect(screen.queryByText("Terminal preview")).toBeNull();

    const terminalSection = areaPanel("Terminal");
    expect(terminalSection.contains(previewPrompt)).toBe(true);

    const terminalCard = terminalFont.closest("div.rounded-lg");
    expect(terminalCard).not.toBeNull();
    expect(terminalCard).toBe(terminalCursor.closest("div.rounded-lg"));
    expect(terminalCard).toBe(blinkCursor.closest("div.rounded-lg"));
    expect(terminalCard?.contains(previewPrompt)).toBe(true);

    // Preview is decorative (aria-hidden) and not wrapped as a SettingsRow.
    const previewRoot = terminalPreviewRoot();
    expect(previewRoot).toBe(previewPrompt.closest('[aria-hidden="true"]'));
  });

  it("applies terminal font family override to the terminal preview", async () => {
    useSettingsStore.setState({
      terminalFontFamily: "Custom Term Font",
      codeFontFamily: "Should Not Win",
    });
    renderPanel(queryClient);
    await goToArea("Terminal");

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontFamily).toBe(
      buildFontFamilyValue("Custom Term Font", DEFAULT_MONO_FONT_STACK),
    );
  });

  it("applies terminal font size override to the terminal preview", async () => {
    useSettingsStore.setState({
      terminalFontSize: 18,
      codeFontSize: 11,
    });
    renderPanel(queryClient);
    await goToArea("Terminal");

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontSize).toBe("18px");
  });

  it("falls back to code font family and size when terminal overrides are null", async () => {
    useSettingsStore.setState({
      terminalFontFamily: null,
      terminalFontSize: null,
      codeFontFamily: "Custom Code Font",
      codeFontSize: 15,
    });
    renderPanel(queryClient);
    await goToArea("Terminal");

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontFamily).toBe(
      buildFontFamilyValue("Custom Code Font", DEFAULT_MONO_FONT_STACK),
    );
    expect(previewRoot.style.fontSize).toBe("15px");
  });

  it("falls back to the default mono stack when terminal and code families are null", async () => {
    useSettingsStore.setState({
      terminalFontFamily: null,
      codeFontFamily: null,
    });
    renderPanel(queryClient);
    await goToArea("Terminal");

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontFamily).toBe(DEFAULT_MONO_FONT_STACK);
  });

  it("toggles icon color palette visibility and preserves colors across re-enable", async () => {
    renderPanel(queryClient);
    await goToArea("Tasks");

    const enableSwitch = screen.getByRole("switch", {
      name: "Color icons by type",
    });
    expect(useSettingsStore.getState().artifactIconColorMode).toBe("byType");
    expect(enableSwitch.getAttribute("data-state")).toBe("checked");

    // Palette visible while type colors are on.
    const ticketColorInput = colorInput("Ticket icon color");
    expect(ticketColorInput.value.toLowerCase()).toBe(
      DEFAULT_EPIC_NODE_ICON_COLORS.ticket,
    );

    // Set a custom color while enabled.
    fireEvent.change(ticketColorInput, { target: { value: "#ff00aa" } });
    expect(useSettingsStore.getState().artifactIconColors.ticket).toBe(
      "#ff00aa",
    );
    expect(ticketColorInput.value.toLowerCase()).toBe("#ff00aa");

    // Toggle off - palette collapses; custom color stays in the store.
    fireEvent.click(enableSwitch);
    expect(useSettingsStore.getState().artifactIconColorMode).toBe("none");
    expect(screen.queryByLabelText("Ticket icon color")).toBeNull();
    expect(useSettingsStore.getState().artifactIconColors.ticket).toBe(
      "#ff00aa",
    );

    // Toggle back on - palette reappears with the preserved custom color.
    fireEvent.click(enableSwitch);
    expect(useSettingsStore.getState().artifactIconColorMode).toBe("byType");
    const restoredInput = colorInput("Ticket icon color");
    expect(restoredInput.value.toLowerCase()).toBe("#ff00aa");
    expect(useSettingsStore.getState().artifactIconColors.ticket).toBe(
      "#ff00aa",
    );
    expect(
      screen.getByRole("button", { name: "Reset icon colors" }),
    ).toBeTruthy();
  });
});

/**
 * Decorative TerminalPreview root: locate via the sample "git status" text
 * and its aria-hidden ancestor (same pattern as the placement test).
 */
function terminalPreviewRoot(): HTMLElement {
  const previewPrompt = screen.getByText("git status");
  const previewRoot = previewPrompt.closest('[aria-hidden="true"]');
  if (!(previewRoot instanceof HTMLElement)) {
    throw new Error('expected terminal preview root with aria-hidden="true"');
  }
  return previewRoot;
}

function colorInput(name: string): HTMLInputElement {
  const el = screen.getByLabelText(name);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`expected color input for "${name}"`);
  }
  return el;
}

async function goToArea(label: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name: label }));
}

function areaPanel(label: string): HTMLElement {
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
