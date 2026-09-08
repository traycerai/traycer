import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeEditorHost } from "@/components/settings/themes/theme-editor-host";
import { ThemeGallery } from "@/components/settings/themes/theme-gallery";
import { ThemeProvider } from "@/providers/theme-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";

function resetThemeStores(): void {
  window.localStorage.clear();
  useThemeLibraryStore.setState({
    version: 1,
    themes: [],
    selected: { light: null, dark: null },
    glassOpacity: 100,
    draft: null,
    error: null,
  });
  useSettingsStore.setState({ theme: "light", themePreset: "neutral" });
}

function renderThemes(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <ThemeGallery />
          <ThemeEditorHost />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function importedTheme(
  id: string,
  name: string,
  appearance: "light" | "dark",
  collection: { id: string; name: string },
): ThemeDefinition {
  return {
    version: 1,
    id,
    name,
    appearance,
    base: "neutral",
    colors: {
      background: appearance === "dark" ? "#101010ff" : "#f4f4f4ff",
      foreground: appearance === "dark" ? "#ffffffff" : "#171717ff",
      primary: "#336699ff",
    },
    syntax: null,
    collection,
  };
}

describe("theme editor flow", () => {
  beforeEach(resetThemeStores);
  afterEach(() => {
    cleanup();
    resetThemeStores();
  });

  it("saves both appearance variants atomically and cancels a later draft", async () => {
    renderThemes();

    fireEvent.click(screen.getByRole("button", { name: "Create theme" }));
    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    fireEvent.change(within(editor).getByPlaceholderText("e.g. Aurora"), {
      target: { value: "Aurora" },
    });
    fireEvent.change(within(editor).getByLabelText("Background color value"), {
      target: { value: "#123456" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Dark" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save theme" }));

    await waitFor(() => {
      expect(useThemeLibraryStore.getState().themes).toHaveLength(2);
    });
    const saved = useThemeLibraryStore.getState();
    expect(saved.themes.map((theme) => theme.appearance).sort()).toEqual([
      "dark",
      "light",
    ]);
    expect(saved.themes.every((theme) => theme.name === "Aurora")).toBe(true);
    expect(saved.selected.light).not.toBeNull();
    expect(saved.selected.dark).not.toBeNull();
    expect(
      saved.themes.find((theme) => theme.appearance === "light")?.colors
        .background,
    ).toBe("#123456ff");

    const savedIds = saved.themes.map((theme) => theme.id);
    fireEvent.click(screen.getByRole("button", { name: "Create theme" }));
    const secondEditor = await screen.findByRole("dialog", {
      name: "Theme editor",
    });
    fireEvent.click(
      within(secondEditor).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => {
      expect(useThemeLibraryStore.getState().draft).toBeNull();
    });
    expect(
      useThemeLibraryStore.getState().themes.map((theme) => theme.id),
    ).toEqual(savedIds);
    expect(useThemeLibraryStore.getState().selected.light).toBe(
      saved.selected.light,
    );
    expect(useThemeLibraryStore.getState().selected.dark).toBe(
      saved.selected.dark,
    );
  });

  it("preserves an imported pack while creating a separate appearance pair", async () => {
    const user = userEvent.setup();
    const collection = { id: "vsix:fixture.pack", name: "Fixture pack" };
    const light = importedTheme(
      "pack-light",
      "Pack Light",
      "light",
      collection,
    );
    const dark = importedTheme("pack-dark", "Pack Dark", "dark", collection);
    const darkAlternate = importedTheme(
      "pack-dark-alternate",
      "Pack Dark Alternate",
      "dark",
      collection,
    );
    expect(
      useThemeLibraryStore.getState().saveThemes([light, dark, darkAlternate]),
    ).toBe(true);
    renderThemes();
    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    await user.click(
      screen.getByRole("option", { name: "Use Pack Dark dark" }),
    );
    expect(useThemeLibraryStore.getState().selected.dark).toBe(dark.id);

    await user.click(screen.getByRole("button", { name: "Manage themes" }));
    const manager = await screen.findByRole("dialog", {
      name: "Manage themes",
    });
    await user.click(
      within(manager).getByRole("button", { name: "Manage Pack Dark" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit theme" }));
    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    expect(screen.queryByRole("dialog", { name: "Manage themes" })).toBeNull();
    expect(document.activeElement).toBe(
      within(editor).getByLabelText("Theme name"),
    );
    fireEvent.change(within(editor).getByLabelText("Background color value"), {
      target: { value: "#202020" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Light" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save theme" }));

    await waitFor(() => {
      expect(useThemeLibraryStore.getState().draft).toBeNull();
    });
    const saved = useThemeLibraryStore.getState().themes;
    expect(saved).toHaveLength(5);
    expect(saved.find((theme) => theme.id === dark.id)).toEqual(dark);
    expect(saved.find((theme) => theme.id === darkAlternate.id)).toEqual(
      darkAlternate,
    );
    expect(saved.find((theme) => theme.id === light.id)).toEqual(light);
    const copied = saved.filter(
      (theme) => theme.collection?.id !== collection.id,
    );
    expect(copied).toHaveLength(2);
    expect(copied.map((theme) => theme.appearance).sort()).toEqual([
      "dark",
      "light",
    ]);
    expect(
      copied.find((theme) => theme.appearance === "dark")?.colors.background,
    ).toBe("#202020ff");
    expect(
      copied.every((theme) => theme.collection?.name === "Pack Dark"),
    ).toBe(true);
  });

  it("keeps appearance choices compact and scoped to their own picker", async () => {
    const user = userEvent.setup();
    renderThemes();

    expect(
      screen.queryByRole("option", { name: "Use Neutral light" }),
    ).toBeNull();
    const lightPicker = screen.getByRole("button", {
      name: "Light theme",
    });

    await user.click(lightPicker);
    const lightSearch = await screen.findByRole("combobox", {
      name: "Search light themes",
    });
    await user.type(lightSearch, "Nord");
    await user.click(screen.getByRole("option", { name: "Use Nord light" }));

    expect(useThemeLibraryStore.getState().selected.light).toBe("nord");
    expect(useThemeLibraryStore.getState().selected.dark).toBeNull();
    expect(useSettingsStore.getState().themePreset).toBe("neutral");
    expect(
      screen.queryByRole("combobox", { name: "Search light themes" }),
    ).toBeNull();

    await user.click(lightPicker);
    const reopenedSearch = await screen.findByRole("combobox", {
      name: "Search light themes",
    });
    await user.clear(reopenedSearch);
    expect(screen.getAllByRole("option")).toHaveLength(17);
  });
});
