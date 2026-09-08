import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real hook reads the appearance blob store (IndexedDB) and the real
// wallpaper paints a canvas; neither exists in jsdom and neither is what these
// tests are about - which rows the group shows for a given wallpaper setting.
const wallpaperMocks = vi.hoisted(() => ({
  image: { url: null as string | null, name: null as string | null },
}));

vi.mock("@/lib/appearance/start-page-wallpaper", () => ({
  chooseStartPageWallpaper: vi.fn(),
  saveStartPageWallpaper: vi.fn(),
  useStartPageWallpaperImage: () => wallpaperMocks.image,
}));

vi.mock("@/components/home/appearance-wallpaper", () => ({
  AppearanceWallpaper: () => null,
}));

import { StartPageSettingsSection } from "@/components/settings/start-page-settings-section";
import { useSettingsStore } from "@/stores/settings/settings-store";

function rowLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".font-medium.text-foreground"),
    (node) => node.textContent,
  );
}

describe("StartPageSettingsSection", () => {
  beforeEach(() => {
    wallpaperMocks.image = { url: null, name: null };
    useSettingsStore.setState({
      startPageWallpaper: null,
      showGreeting: true,
      showRecentHistory: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("hides Style and Intensity until a wallpaper is set", () => {
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual(["Wallpaper", "Greeting", "Recent tasks"]);
    expect(screen.getByText("None")).not.toBeNull();
  });

  it("shows Style and Intensity once a dithered wallpaper is set", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: { style: "dither", intensity: 0.6 },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Style",
      "Intensity",
      "Greeting",
      "Recent tasks",
    ]);
    expect(screen.getByText("ridge.png")).not.toBeNull();
    expect(
      screen.getByRole("slider", { name: "Intensity" }).getAttribute("value"),
    ).toBe("60");
  });

  it("keeps Style but drops Intensity for the photo treatment", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: { style: "photo", intensity: 0.6 },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Style",
      "Greeting",
      "Recent tasks",
    ]);
  });
});
