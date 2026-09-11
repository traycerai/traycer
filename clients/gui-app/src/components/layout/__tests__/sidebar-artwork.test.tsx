import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThemeFromPreset } from "@/lib/themes/theme-library";
import { TabSurfaceActivityContext } from "@/components/layout/tab-surface-activity-context";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

const wallpaperMocks = vi.hoisted(() => ({
  image: { url: "blob:wallpaper", name: "wallpaper.png" },
}));
const activityMocks = vi.hoisted(() => ({ visible: true, focused: true }));

vi.mock("@/lib/appearance/start-page-wallpaper", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/appearance/start-page-wallpaper")
    >();
  return {
    ...actual,
    useStartPageWallpaperImage: () => wallpaperMocks.image,
  };
});

import { SidebarArtwork } from "@/components/layout/sidebar-artwork";

function setWallpaper(
  style: "photo" | "dither" | "grain",
  intensity: number,
  tintWithAccent: boolean,
): void {
  useSettingsStore.setState({
    startPageWallpaper: {
      style,
      intensity,
      tintWithAccent,
      name: "wallpaper.png",
    },
  });
}

function renderArtwork() {
  return render(
    <TabSurfaceActivityContext.Provider value={activityMocks}>
      <SidebarArtwork />
    </TabSurfaceActivityContext.Provider>,
  );
}

describe("SidebarArtwork", () => {
  beforeEach(() => {
    activityMocks.visible = true;
    wallpaperMocks.image = { url: "blob:wallpaper", name: "wallpaper.png" };
    act(() => {
      useThemeLibraryStore.setState({
        draft: {
          ...createThemeFromPreset("neutral", "dark"),
          sidebarArtwork: true,
        },
      });
      setWallpaper("grain", 0.6, true);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        readonly naturalWidth = 100;
        readonly naturalHeight = 100;
        set src(_value: string) {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    act(() => {
      useSettingsStore.setState({ startPageWallpaper: null });
      useThemeLibraryStore.setState({ draft: null });
    });
    vi.unstubAllGlobals();
  });

  it("forwards the configured treatments and hides when the theme or surface is inactive", () => {
    const { container, rerender } = renderArtwork();
    const grain = container.querySelector(".appearance-wallpaper");
    expect(grain).not.toBeNull();
    expect(grain?.querySelector("img")?.style.opacity).toBe("0.66");
    expect(
      Number(
        grain?.querySelector<HTMLElement>(".appearance-wallpaper-texture")
          ?.style.opacity,
      ),
    ).toBeCloseTo(0.45);

    act(() => setWallpaper("dither", 0.25, false));
    act(() =>
      rerender(
        <TabSurfaceActivityContext.Provider value={activityMocks}>
          <SidebarArtwork />
        </TabSurfaceActivityContext.Provider>,
      ),
    );
    expect(container.querySelector(".appearance-wallpaper canvas")).not.toBe(
      null,
    );

    act(() => setWallpaper("photo", 0.6, true));
    act(() =>
      rerender(
        <TabSurfaceActivityContext.Provider value={activityMocks}>
          <SidebarArtwork />
        </TabSurfaceActivityContext.Provider>,
      ),
    );
    expect(container.querySelector(".appearance-wallpaper img")).not.toBe(null);
    expect(container.querySelector(".appearance-wallpaper-texture")).toBeNull();

    act(() => useThemeLibraryStore.setState({ draft: null }));
    act(() =>
      rerender(
        <TabSurfaceActivityContext.Provider value={activityMocks}>
          <SidebarArtwork />
        </TabSurfaceActivityContext.Provider>,
      ),
    );
    expect(container.querySelector(".sidebar-artwork")).toBeNull();

    act(() =>
      useThemeLibraryStore.setState({
        draft: {
          ...createThemeFromPreset("neutral", "dark"),
          sidebarArtwork: true,
        },
      }),
    );
    activityMocks.visible = false;
    act(() =>
      rerender(
        <TabSurfaceActivityContext.Provider value={activityMocks}>
          <SidebarArtwork />
        </TabSurfaceActivityContext.Provider>,
      ),
    );
    expect(container.querySelector(".sidebar-artwork")).toBeNull();
  });
});
