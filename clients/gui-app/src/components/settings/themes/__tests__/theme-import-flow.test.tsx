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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeGallery } from "@/components/settings/themes/theme-gallery";
import { ThemeProvider } from "@/providers/theme-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

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
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("theme import flow", () => {
  beforeEach(() => {
    resetThemeStores();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ extensions: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetThemeStores();
  });

  it("previews JSON without saving, cancels, then saves the import", async () => {
    const user = userEvent.setup();
    renderThemes();

    await user.click(screen.getByRole("button", { name: "Import theme" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Find your next palette",
    });
    expect(
      within(dialog).getByRole("tab", { name: "Browse themes" }),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("tab", { name: "Import files" }));
    await user.click(within(dialog).getByText("Paste theme JSON"));

    fireEvent.change(within(dialog).getByLabelText("Theme JSON"), {
      target: {
        value: JSON.stringify({
          name: "Flow fixture",
          type: "dark",
          colors: {
            "editor.background": "#101010",
            "button.background": "#336699",
          },
        }),
      },
    });
    const previewButton = within(dialog).getByRole("button", {
      name: "Preview import",
    });
    await user.click(previewButton);

    await within(dialog).findByText("1 theme ready to import");
    expect(useThemeLibraryStore.getState().themes).toEqual([]);
    expect(useThemeLibraryStore.getState().selected).toEqual({
      light: null,
      dark: null,
    });

    await user.click(
      within(dialog).getByRole("tab", { name: "Browse themes" }),
    );
    await user.click(within(dialog).getByRole("tab", { name: "Import files" }));
    await user.click(within(dialog).getByText("Paste theme JSON"));
    expect(within(dialog).getByLabelText("Theme JSON")).toHaveProperty(
      "value",
      expect.stringContaining('"Flow fixture"'),
    );
    expect(within(dialog).getByText("1 theme ready to import")).toBeTruthy();

    await user.click(
      within(dialog).getByRole("button", { name: "Cancel import" }),
    );
    await waitFor(() => {
      expect(within(dialog).queryByText("1 theme ready to import")).toBeNull();
    });
    expect(useThemeLibraryStore.getState().themes).toEqual([]);
    expect(within(dialog).getByLabelText("Theme JSON")).toHaveProperty(
      "value",
      expect.stringContaining('"Flow fixture"'),
    );

    await user.click(
      within(dialog).getByRole("button", { name: "Preview import" }),
    );
    await within(dialog).findByText("1 theme ready to import");
    await user.click(
      within(dialog).getByRole("button", { name: "Add to library" }),
    );

    await waitFor(() => {
      expect(useThemeLibraryStore.getState().themes).toHaveLength(1);
    });
    expect(useThemeLibraryStore.getState().themes[0]?.name).toBe(
      "Flow fixture",
    );
  });
});
