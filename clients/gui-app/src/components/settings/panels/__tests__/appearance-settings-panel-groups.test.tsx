import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import {
  buildFontFamilyValue,
  DEFAULT_MONO_FONT_STACK,
} from "@/lib/default-font-stacks";
import {
  DEFAULT_CODE_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

// The Start page group's wallpaper gallery fetches its catalog from the CDN.
// An empty catalog keeps this suite off the network without changing which
// rows - and so which search anchors - the panel renders.
vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackSettingChanged: vi.fn(),
}));

// Only `trackSettingChanged` is stubbed: the panel also imports
// `trackedSettingSetter` from this module, and replacing the whole module
// leaves every other row's setter undefined.
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: analyticsMocks.trackSettingChanged,
}));

const GROUP_TITLES = [
  "Themes",
  "Start page",
  "Interface",
  "Fonts and text",
  "Motion and readability",
  "Terminal",
  "Icon colors",
] as const;

function resetAppearanceSettings(): void {
  useSettingsStore.setState({
    artifactIconColorMode: "byType",
    artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
    pointerCursors: true,
    chatTurnMinimapSide: "right",
    codeFontFamily: null,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    terminalFontFamily: null,
    terminalFontSize: null,
  });
}

describe("<AppearanceSettingsPanel /> groups", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createQueryClient();
    resetAppearanceSettings();
    analyticsMocks.trackSettingChanged.mockReset();
    useThemeLibraryStore.setState({ glassOpacity: 100 });
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    resetAppearanceSettings();
  });

  it("emits exactly one glassOpacity analytics event for a keyboard change", () => {
    renderPanel(queryClient);

    const slider = screen.getByRole("slider", { name: "Background opacity" });
    // A real browser moves the value on ArrowLeft before any key event
    // reaches userspace; jsdom does not, so the change is simulated here
    // the same way the pointer-drag path is simulated (fireEvent.change),
    // leaving keyUp to answer only for the analytics side of the fix.
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.change(slider, { target: { value: "90" } });
    fireEvent.keyUp(slider, { key: "ArrowLeft" });

    expect(useThemeLibraryStore.getState().glassOpacity).toBe(90);
    expect(analyticsMocks.trackSettingChanged).toHaveBeenCalledTimes(1);
    expect(analyticsMocks.trackSettingChanged).toHaveBeenCalledWith(
      "appearance",
      "glassOpacity",
    );
  });

  it("reports nothing for a keyboard press the clamp leaves unmoved", () => {
    // 30 is the slider's floor, so ArrowLeft there changes nothing and there
    // is no setting change to report.
    useThemeLibraryStore.setState({ glassOpacity: 30 });
    renderPanel(queryClient);

    const slider = screen.getByRole("slider", { name: "Background opacity" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyUp(slider, { key: "ArrowLeft" });

    expect(useThemeLibraryStore.getState().glassOpacity).toBe(30);
    expect(analyticsMocks.trackSettingChanged).not.toHaveBeenCalled();
  });

  it("renders the named group headings in order", () => {
    renderPanel(queryClient);

    const themes = screen.getByRole("heading", { level: 2, name: "Themes" });
    const startPage = screen.getByRole("heading", {
      level: 2,
      name: "Start page",
    });
    const iface = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    const fontsAndText = screen.getByRole("heading", {
      level: 2,
      name: "Fonts and text",
    });
    const motion = screen.getByRole("heading", {
      level: 2,
      name: "Motion and readability",
    });
    const terminal = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const iconColors = screen.getByRole("heading", {
      level: 2,
      name: "Icon colors",
    });

    expect(documentPosition(themes, iface)).toBe("before");
    expect(documentPosition(themes, startPage)).toBe("before");
    expect(documentPosition(startPage, iface)).toBe("before");
    expect(documentPosition(iface, fontsAndText)).toBe("before");
    expect(documentPosition(fontsAndText, motion)).toBe("before");
    expect(documentPosition(motion, terminal)).toBe("before");
    expect(documentPosition(terminal, iconColors)).toBe("before");
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

  it("renders named sections as h2 headings outside separate bordered cards", () => {
    renderPanel(queryClient);

    // SettingsGroup renders real <h2> labels, not row-shaped bands inside a
    // single shared card. Each group is its own <section>; the h2 and the
    // bordered rows-container are siblings.
    const headings = GROUP_TITLES.map((title) =>
      screen.getByRole("heading", { level: 2, name: title }),
    );

    for (const heading of headings) {
      const section = heading.closest("section");
      expect(section).not.toBeNull();
      // Heading sits outside the bordered card (sibling of the card div).
      expect(heading.closest("div.rounded-lg")).toBeNull();
      expect(section?.contains(heading)).toBe(true);
    }

    const themesHeading = screen.getByRole("heading", {
      level: 2,
      name: "Themes",
    });
    const interfaceHeading = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    const fontsAndTextHeading = screen.getByRole("heading", {
      level: 2,
      name: "Fonts and text",
    });
    const motionHeading = screen.getByRole("heading", {
      level: 2,
      name: "Motion and readability",
    });
    const terminalHeading = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const iconColorsHeading = screen.getByRole("heading", {
      level: 2,
      name: "Icon colors",
    });

    const schemeButton = screen.getByRole("button", { name: "Follow device" });
    const preset = screen.getByRole("button", { name: "Light theme" });
    const backgroundOpacity = screen.getByText("Background opacity");
    const pointerCursors = screen.getByText(
      "Show a hand cursor over clickable controls",
    );
    const interfaceFont = screen.getByText("Interface font");
    const codeFont = screen.getByText("Code font");
    const promptFont = screen.getByText("Prompt font");
    const fontLigatures = screen.getByText("Use font ligatures");
    const panelAnimations = screen.getByText("Panel animations");
    const terminalFont = screen.getByText("Terminal font");
    const terminalCursor = screen.getByText("Terminal cursor");
    const blinkCursor = screen.getByText("Blink cursor");
    const iconColors = screen.getAllByText("Color icons by type")[0];

    expect(themesHeading.closest("div.rounded-lg")).toBeNull();
    // The theme-mode control is a row of the Themes group, so it shares that
    // group's section and its bordered card with the theme slots.
    expect(schemeButton.closest("section")).toBe(
      themesHeading.closest("section"),
    );
    expect(schemeButton.closest("div.rounded-lg")).toBe(
      preset.closest("div.rounded-lg"),
    );
    expect(backgroundOpacity.closest("div.rounded-lg")).toBe(
      preset.closest("div.rounded-lg"),
    );
    expect(preset.closest("section")).toBe(themesHeading.closest("section"));
    expect(interfaceFont.closest("div.rounded-lg")).toBe(
      codeFont.closest("div.rounded-lg"),
    );
    expect(promptFont.closest("div.rounded-lg")).toBe(
      interfaceFont.closest("div.rounded-lg"),
    );
    expect(fontLigatures.closest("div.rounded-lg")).toBe(
      interfaceFont.closest("div.rounded-lg"),
    );
    expect(terminalFont.closest("div.rounded-lg")).toBe(
      terminalCursor.closest("div.rounded-lg"),
    );
    expect(terminalCursor.closest("div.rounded-lg")).toBe(
      blinkCursor.closest("div.rounded-lg"),
    );

    // Rows from different groups do NOT share a card.
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
      iconColors.closest("div.rounded-lg"),
    );

    // Each heading's section owns its representative row.
    const themeModeGroup = screen.getByRole("group", {
      name: "Theme mode",
    });
    const themeList = themesHeading.nextElementSibling;
    expect(themeModeGroup.contains(schemeButton)).toBe(true);
    expect(themeList?.contains(preset)).toBe(true);
    expect(interfaceHeading.closest("section")).toBe(
      pointerCursors.closest("section"),
    );
    expect(fontsAndTextHeading.closest("section")).toBe(
      interfaceFont.closest("section"),
    );
    expect(motionHeading.closest("section")).toBe(
      panelAnimations.closest("section"),
    );
    expect(terminalHeading.closest("section")).toBe(
      terminalFont.closest("section"),
    );
    expect(iconColorsHeading.closest("section")).toBe(
      iconColors.closest("section"),
    );

    // Distinct sections per group.
    expect(themesHeading.closest("section")).not.toBe(
      interfaceHeading.closest("section"),
    );
    expect(interfaceHeading.closest("section")).not.toBe(
      fontsAndTextHeading.closest("section"),
    );
    expect(fontsAndTextHeading.closest("section")).not.toBe(
      motionHeading.closest("section"),
    );
    expect(motionHeading.closest("section")).not.toBe(
      terminalHeading.closest("section"),
    );
    expect(terminalHeading.closest("section")).not.toBe(
      iconColorsHeading.closest("section"),
    );
  });

  it("places representative rows under the correct section headers", () => {
    renderPanel(queryClient);

    const themes = screen.getByRole("heading", { level: 2, name: "Themes" });
    const startPage = screen.getByRole("heading", {
      level: 2,
      name: "Start page",
    });
    const iface = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    const fontsAndText = screen.getByRole("heading", {
      level: 2,
      name: "Fonts and text",
    });
    const motion = screen.getByRole("heading", {
      level: 2,
      name: "Motion and readability",
    });
    const terminal = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const iconColors = screen.getByRole("heading", {
      level: 2,
      name: "Icon colors",
    });

    const schemeButton = screen.getByRole("button", { name: "Follow device" });
    const preset = screen.getByRole("button", { name: "Light theme" });
    const backgroundOpacity = screen.getByText("Background opacity");
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

    // Theme controls sit between the Themes heading and Start page, the mode
    // row first.
    expect(documentPosition(themes, schemeButton)).toBe("before");
    expect(documentPosition(schemeButton, preset)).toBe("before");
    expect(documentPosition(preset, backgroundOpacity)).toBe("before");
    expect(documentPosition(themes, startPage)).toBe("before");
    expect(documentPosition(preset, iface)).toBe("before");

    // Interface rows sit between that header and Fonts and text.
    expect(documentPosition(iface, pointerCursors)).toBe("before");
    expect(documentPosition(pointerCursors, fontsAndText)).toBe("before");
    // Pointer cursors is not still in Theme.
    expect(documentPosition(themes, pointerCursors)).toBe("before");
    expect(documentPosition(pointerCursors, iface)).not.toBe("before");

    // Fonts and text rows precede Motion and readability.
    expect(documentPosition(fontsAndText, interfaceFont)).toBe("before");
    expect(documentPosition(interfaceFont, codeFont)).toBe("before");
    expect(documentPosition(codeFont, promptFont)).toBe("before");
    expect(documentPosition(promptFont, fontLigatures)).toBe("before");
    expect(documentPosition(fontLigatures, motion)).toBe("before");

    expect(documentPosition(motion, panelAnimations)).toBe("before");
    expect(documentPosition(panelAnimations, animationDuration)).toBe("before");
    expect(documentPosition(animationDuration, textContrast)).toBe("before");
    expect(documentPosition(textContrast, terminal)).toBe("before");

    // Terminal rows before Icon colors.
    expect(documentPosition(terminal, terminalFont)).toBe("before");
    expect(documentPosition(terminalFont, terminalCursor)).toBe("before");
    expect(documentPosition(terminalCursor, blinkCursor)).toBe("before");
    expect(documentPosition(blinkCursor, iconColors)).toBe("before");

    // Icon colors content after its header.
    expect(documentPosition(iconColors, artifactIconColors)).toBe("before");
  });

  it("renders the terminal preview inside the Terminal card without a row label", () => {
    renderPanel(queryClient);

    const terminalHeading = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const terminalFont = screen.getByText("Terminal font");
    const terminalCursor = screen.getByText("Terminal cursor");
    const blinkCursor = screen.getByText("Blink cursor");
    const previewPrompt = screen.getByText("git status");

    // No labeled "Terminal preview" row - the decorative preview sits bare in
    // the card next to the terminal controls.
    expect(screen.queryByText("Terminal preview")).toBeNull();

    const terminalSection = terminalHeading.closest("section");
    expect(terminalSection).not.toBeNull();
    expect(terminalSection?.contains(previewPrompt)).toBe(true);

    const terminalCard = terminalFont.closest("div.rounded-lg");
    expect(terminalCard).not.toBeNull();
    expect(terminalCard).toBe(terminalCursor.closest("div.rounded-lg"));
    expect(terminalCard).toBe(blinkCursor.closest("div.rounded-lg"));
    expect(terminalCard?.contains(previewPrompt)).toBe(true);

    // Preview is decorative (aria-hidden) and not wrapped as a SettingsRow.
    const previewRoot = terminalPreviewRoot();
    expect(previewRoot).toBe(previewPrompt.closest('[aria-hidden="true"]'));
  });

  it("applies terminal font family override to the terminal preview", () => {
    useSettingsStore.setState({
      terminalFontFamily: "Custom Term Font",
      codeFontFamily: "Should Not Win",
    });
    renderPanel(queryClient);

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontFamily).toBe(
      buildFontFamilyValue("Custom Term Font", DEFAULT_MONO_FONT_STACK),
    );
  });

  it("applies terminal font size override to the terminal preview", () => {
    useSettingsStore.setState({
      terminalFontSize: 18,
      codeFontSize: 11,
    });
    renderPanel(queryClient);

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontSize).toBe("18px");
  });

  it("falls back to code font family and size when terminal overrides are null", () => {
    useSettingsStore.setState({
      terminalFontFamily: null,
      terminalFontSize: null,
      codeFontFamily: "Custom Code Font",
      codeFontSize: 15,
    });
    renderPanel(queryClient);

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontFamily).toBe(
      buildFontFamilyValue("Custom Code Font", DEFAULT_MONO_FONT_STACK),
    );
    expect(previewRoot.style.fontSize).toBe("15px");
  });

  it("falls back to the default mono stack when terminal and code families are null", () => {
    useSettingsStore.setState({
      terminalFontFamily: null,
      codeFontFamily: null,
    });
    renderPanel(queryClient);

    const previewRoot = terminalPreviewRoot();
    expect(previewRoot.style.fontFamily).toBe(DEFAULT_MONO_FONT_STACK);
  });

  it("toggles icon color palette visibility and preserves colors across re-enable", () => {
    renderPanel(queryClient);

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

function documentPosition(
  earlier: HTMLElement,
  later: HTMLElement,
): "before" | "after" | "unrelated" {
  const relation = earlier.compareDocumentPosition(later);
  if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return "before";
  if ((relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return "after";
  return "unrelated";
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
