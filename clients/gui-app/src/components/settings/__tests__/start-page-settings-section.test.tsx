import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real hook reads the appearance blob store (IndexedDB), which does not
// exist in jsdom and is not what these tests are about - which rows the group
// shows for a given wallpaper setting.
const wallpaperMocks = vi.hoisted(() => ({
  image: { url: null as string | null, name: null as string | null },
  choose: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: wallpaperMocks.toastError } }));

vi.mock("@/lib/appearance/start-page-wallpaper", () => ({
  chooseStartPageWallpaper: wallpaperMocks.choose,
  removeStartPageWallpaper: wallpaperMocks.remove,
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
    // The real `removeStartPageWallpaper` clears the settings row itself
    // (see FIX 3: one entry point owns both writes) - mirror that here so a
    // test observes the same "immediate" state the real module produces.
    wallpaperMocks.remove.mockReset().mockImplementation(() => {
      useSettingsStore.setState({ startPageWallpaper: null });
      return Promise.resolve();
    });
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

  it("hides wallpaper effects until a wallpaper is set", () => {
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Show greeting",
      "Show recent tasks",
    ]);
    expect(screen.getByText("None")).not.toBeNull();
  });

  it("names a stored wallpaper with no filename as a custom image", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: null };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "photo",
        intensity: 0.6,
        tintWithAccent: true,
        name: null,
      },
    });

    render(<StartPageSettingsSection />);

    expect(screen.getByText("Custom image")).not.toBeNull();
    expect(screen.queryByText("None")).toBeNull();
  });

  it("shows wallpaper effect controls once a dithered wallpaper is set", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "ridge.png",
      },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Wallpaper effect",
      "Effect strength",
      "Tint wallpaper with theme accent color",
      "Show greeting",
      "Show recent tasks",
    ]);
    expect(
      screen
        .getByRole("switch", { name: "Tint wallpaper with theme accent color" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("ridge.png")).not.toBeNull();
    expect(
      screen
        .getByRole("slider", { name: "Effect strength" })
        .getAttribute("value"),
    ).toBe("60");
    expect(screen.getByText("Subtle")).not.toBeNull();
    expect(screen.getByText("Strong")).not.toBeNull();
  });

  it("keeps the effect picker but drops strength for the photo treatment", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "photo",
        intensity: 0.6,
        tintWithAccent: true,
        name: "ridge.png",
      },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Wallpaper effect",
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
        name: "ridge.png",
      },
    });
    render(<StartPageSettingsSection />);
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Wallpaper effect",
      "Effect strength",
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
        name: "ridge.png",
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
    wallpaperMocks.remove.mockImplementation(() => {
      wallpaperMocks.image = { url: null, name: null };
      useSettingsStore.setState({ startPageWallpaper: null });
      return Promise.resolve();
    });
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "ridge.png",
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
    wallpaperMocks.remove.mockRejectedValue(error);
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "photo",
        intensity: 0.6,
        tintWithAccent: true,
        name: "ridge.png",
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
