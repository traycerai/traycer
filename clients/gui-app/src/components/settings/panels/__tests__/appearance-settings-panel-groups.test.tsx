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

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

const GROUP_TITLES = [
  "Theme",
  "Interface",
  "Typography",
  "Terminal",
  "Artifact icons",
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
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    resetAppearanceSettings();
  });

  it("renders the five named group headings in order", () => {
    renderPanel(queryClient);

    const theme = screen.getByRole("heading", { level: 2, name: "Theme" });
    const iface = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    const typography = screen.getByRole("heading", {
      level: 2,
      name: "Typography",
    });
    const terminal = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const artifactIcons = screen.getByRole("heading", {
      level: 2,
      name: "Artifact icons",
    });

    expect(documentPosition(theme, iface)).toBe("before");
    expect(documentPosition(iface, typography)).toBe("before");
    expect(documentPosition(typography, terminal)).toBe("before");
    expect(documentPosition(terminal, artifactIcons)).toBe("before");
  });

  it("offers a shared hide option for chat and artifact minimaps", () => {
    renderPanel(queryClient);

    fireEvent.click(screen.getByRole("combobox", { name: "Minimap side" }));
    fireEvent.click(screen.getByRole("option", { name: "Hide" }));

    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("hide");
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

    const themeHeading = screen.getByRole("heading", {
      level: 2,
      name: "Theme",
    });
    const interfaceHeading = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    const typographyHeading = screen.getByRole("heading", {
      level: 2,
      name: "Typography",
    });
    const terminalHeading = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const artifactHeading = screen.getByRole("heading", {
      level: 2,
      name: "Artifact icons",
    });

    // Representative rows live inside each section's card, not the heading.
    const themeRow = rowLabel("Theme");
    const preset = screen.getByText("Preset");
    const pointerCursors = screen.getByText("Use pointer cursors");
    const uiFont = screen.getByText("UI font");
    const codeFont = screen.getByText("Code font");
    const terminalFont = screen.getByText("Terminal font");
    const terminalCursor = screen.getByText("Terminal cursor");
    const blinkCursor = screen.getByText("Blink cursor");
    const artifactIconColors = screen.getByText("Artifact icon colors");

    // Heading and its rows do NOT share the closest bordered card.
    expect(themeHeading.closest("div.rounded-lg")).toBeNull();
    expect(themeRow.closest("div.rounded-lg")).not.toBeNull();
    expect(themeRow.closest("div.rounded-lg")).not.toBe(
      themeHeading.closest("div.rounded-lg"),
    );

    // Two rows in the same group DO share the bordered card.
    expect(themeRow.closest("div.rounded-lg")).toBe(
      preset.closest("div.rounded-lg"),
    );
    expect(uiFont.closest("div.rounded-lg")).toBe(
      codeFont.closest("div.rounded-lg"),
    );
    expect(terminalFont.closest("div.rounded-lg")).toBe(
      terminalCursor.closest("div.rounded-lg"),
    );
    expect(terminalCursor.closest("div.rounded-lg")).toBe(
      blinkCursor.closest("div.rounded-lg"),
    );

    // Rows from different groups do NOT share a card.
    expect(themeRow.closest("div.rounded-lg")).not.toBe(
      pointerCursors.closest("div.rounded-lg"),
    );
    expect(pointerCursors.closest("div.rounded-lg")).not.toBe(
      uiFont.closest("div.rounded-lg"),
    );
    expect(uiFont.closest("div.rounded-lg")).not.toBe(
      terminalFont.closest("div.rounded-lg"),
    );
    expect(terminalFont.closest("div.rounded-lg")).not.toBe(
      artifactIconColors.closest("div.rounded-lg"),
    );

    // Each heading's section owns its representative row.
    expect(themeHeading.closest("section")).toBe(themeRow.closest("section"));
    expect(interfaceHeading.closest("section")).toBe(
      pointerCursors.closest("section"),
    );
    expect(typographyHeading.closest("section")).toBe(
      uiFont.closest("section"),
    );
    expect(terminalHeading.closest("section")).toBe(
      terminalFont.closest("section"),
    );
    expect(artifactHeading.closest("section")).toBe(
      artifactIconColors.closest("section"),
    );

    // Distinct sections per group.
    expect(themeHeading.closest("section")).not.toBe(
      interfaceHeading.closest("section"),
    );
    expect(interfaceHeading.closest("section")).not.toBe(
      typographyHeading.closest("section"),
    );
    expect(typographyHeading.closest("section")).not.toBe(
      terminalHeading.closest("section"),
    );
    expect(terminalHeading.closest("section")).not.toBe(
      artifactHeading.closest("section"),
    );
  });

  it("places representative rows under the correct section headers", () => {
    renderPanel(queryClient);

    const theme = screen.getByRole("heading", { level: 2, name: "Theme" });
    const iface = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    const typography = screen.getByRole("heading", {
      level: 2,
      name: "Typography",
    });
    const terminal = screen.getByRole("heading", {
      level: 2,
      name: "Terminal",
    });
    const artifactIcons = screen.getByRole("heading", {
      level: 2,
      name: "Artifact icons",
    });

    const themeRow = rowLabel("Theme");
    const preset = screen.getByText("Preset");
    const pointerCursors = screen.getByText("Use pointer cursors");
    const uiFont = screen.getByText("UI font");
    const codeFont = screen.getByText("Code font");
    const terminalFont = screen.getByText("Terminal font");
    const terminalCursor = screen.getByText("Terminal cursor");
    const blinkCursor = screen.getByText("Blink cursor");
    const artifactIconColors = screen.getByText("Artifact icon colors");

    // Theme rows sit between that header and Interface.
    expect(documentPosition(theme, themeRow)).toBe("before");
    expect(documentPosition(themeRow, preset)).toBe("before");
    expect(documentPosition(preset, iface)).toBe("before");

    // Interface rows sit between that header and Typography.
    expect(documentPosition(iface, pointerCursors)).toBe("before");
    expect(documentPosition(pointerCursors, typography)).toBe("before");
    // Pointer cursors is not still in Theme.
    expect(documentPosition(theme, pointerCursors)).toBe("before");
    expect(documentPosition(pointerCursors, iface)).not.toBe("before");

    // Typography: UI font and Code font before Terminal.
    expect(documentPosition(typography, uiFont)).toBe("before");
    expect(documentPosition(uiFont, codeFont)).toBe("before");
    expect(documentPosition(codeFont, terminal)).toBe("before");

    // Terminal rows before Artifact icons.
    expect(documentPosition(terminal, terminalFont)).toBe("before");
    expect(documentPosition(terminalFont, terminalCursor)).toBe("before");
    expect(documentPosition(terminalCursor, blinkCursor)).toBe("before");
    expect(documentPosition(blinkCursor, artifactIcons)).toBe("before");

    // Artifact icons content after its header.
    expect(documentPosition(artifactIcons, artifactIconColors)).toBe("before");
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

  it("toggles artifact icon palette visibility and preserves colors across re-enable", () => {
    renderPanel(queryClient);

    const enableSwitch = screen.getByRole("switch", {
      name: "Use artifact type colors",
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
      screen.getByRole("button", { name: "Reset artifact icon colors" }),
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

/**
 * SettingsRow label for "Theme" (not the group <h2>). The panel has both an
 * h2 "Theme" and a row label "Theme"; filter to the non-heading text node.
 */
function rowLabel(label: string): HTMLElement {
  const matches = screen.getAllByText(label);
  const row = matches.find((el) => el.tagName !== "H2");
  if (row === undefined) {
    throw new Error(`expected SettingsRow label "${label}"`);
  }
  return row;
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
