import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real hook reads the appearance blob store (IndexedDB), which does not
// exist in jsdom and is not what these tests are about - which rows the group
// shows for a given wallpaper setting.
const wallpaperMocks = vi.hoisted(() => ({
  image: { url: null as string | null, name: null as string | null },
  choose: vi.fn(),
  save: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: wallpaperMocks.toastError } }));

vi.mock("@/lib/appearance/start-page-wallpaper", () => ({
  chooseStartPageWallpaper: wallpaperMocks.choose,
  saveStartPageWallpaper: wallpaperMocks.save,
  useStartPageWallpaperImage: () => wallpaperMocks.image,
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
    wallpaperMocks.choose.mockReset().mockResolvedValue(undefined);
    wallpaperMocks.save.mockReset().mockResolvedValue(undefined);
    wallpaperMocks.toastError.mockReset();
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
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Show greeting",
      "Show recent tasks",
    ]);
    expect(screen.getByText("None")).not.toBeNull();
  });

  it("shows Style and Intensity once a dithered wallpaper is set", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
      },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Style",
      "Intensity",
      "Use accent color",
      "Show greeting",
      "Show recent tasks",
    ]);
    expect(
      screen
        .getByRole("switch", { name: "Use accent color" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("ridge.png")).not.toBeNull();
    expect(
      screen.getByRole("slider", { name: "Intensity" }).getAttribute("value"),
    ).toBe("60");
  });

  it("keeps Style but drops Intensity for the photo treatment", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "photo",
        intensity: 0.6,
        tintWithAccent: true,
      },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Style",
      "Show greeting",
      "Show recent tasks",
    ]);
  });

  it("keeps the tint switch off the grain treatment, which has no ramp", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "grain",
        intensity: 0.6,
        tintWithAccent: true,
      },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Style",
      "Intensity",
      "Show greeting",
      "Show recent tasks",
    ]);
  });

  it("renders no preview card: the start page itself is the preview", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
      },
    });
    render(<StartPageSettingsSection />);
    expect(screen.queryByTestId("start-page-preview")).toBeNull();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("makes removal immediate while an upload is pending", async () => {
    const choose = { resolve: (): void => undefined };
    wallpaperMocks.choose.mockReturnValue(
      new Promise<void>((resolve) => {
        choose.resolve = () => resolve();
      }),
    );
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    wallpaperMocks.save.mockImplementation(() => {
      wallpaperMocks.image = { url: null, name: null };
      return Promise.resolve();
    });
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
      },
    });
    render(<StartPageSettingsSection />);

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("expected wallpaper file input");
    await userEvent.upload(
      input,
      new File(["image"], "new.png", { type: "image/png" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Choose image…" })
        .matches(":disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      screen
        .getByRole("button", { name: "Choose image…" })
        .matches(":disabled"),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Show greeting",
      "Show recent tasks",
    ]);
    choose.resolve();
  });

  it("surfaces a failed removal", async () => {
    const error = new Error("storage unavailable");
    wallpaperMocks.save.mockRejectedValue(error);
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "photo",
        intensity: 0.6,
        tintWithAccent: true,
      },
    });
    render(<StartPageSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() =>
      expect(wallpaperMocks.toastError).toHaveBeenCalledWith(
        "storage unavailable",
      ),
    );
  });
});
