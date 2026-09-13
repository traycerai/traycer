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
  applyCurated: vi.fn(),
  fetchManifest: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: wallpaperMocks.toastError } }));

vi.mock("@/lib/appearance/start-page-wallpaper", () => ({
  applyCuratedStartPageWallpaper: wallpaperMocks.applyCurated,
  chooseStartPageWallpaper: wallpaperMocks.choose,
  removeStartPageWallpaper: wallpaperMocks.remove,
  useStartPageWallpaperImage: () => wallpaperMocks.image,
}));

// The gallery fetches its catalog from the CDN; a unit suite about which rows
// the group shows must not reach the network to find out.
vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: wallpaperMocks.fetchManifest,
}));

const analyticsMocks = vi.hoisted(() => ({
  trackSettingChanged: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  trackSettingChanged: analyticsMocks.trackSettingChanged,
}));

import { StartPageSettingsSection } from "@/components/settings/start-page-settings-section";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { CuratedWallpaper } from "@/lib/appearance/curated-wallpapers";

function renderSection(): void {
  render(<StartPageSettingsSection />, { wrapper: WithTestQueryClient });
}

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
    wallpaperMocks.applyCurated.mockReset().mockResolvedValue(undefined);
    wallpaperMocks.fetchManifest.mockReset().mockResolvedValue([]);
    wallpaperMocks.toastError.mockReset();
    analyticsMocks.trackSettingChanged.mockReset();
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
    renderSection();
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Traycer team curated wallpapers",
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
        curatedId: null,
      },
    });

    renderSection();

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
        curatedId: null,
      },
    });
    renderSection();
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Traycer team curated wallpapers",
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

  it("keeps strength for the photo treatment, where it sets the veil", () => {
    wallpaperMocks.image = { url: "blob:wallpaper", name: "ridge.png" };
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "photo",
        intensity: 0.6,
        tintWithAccent: true,
        name: "ridge.png",
        curatedId: null,
      },
    });
    renderSection();
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Traycer team curated wallpapers",
      "Wallpaper effect",
      "Effect strength",
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
        curatedId: null,
      },
    });
    renderSection();
    expect(rowLabels()).toEqual([
      "Wallpaper",
      "Traycer team curated wallpapers",
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
        curatedId: null,
      },
    });
    renderSection();
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
        curatedId: null,
      },
    });
    renderSection();

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
      "Traycer team curated wallpapers",
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
        curatedId: null,
      },
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() =>
      expect(wallpaperMocks.toastError).toHaveBeenCalledWith(
        "storage unavailable",
      ),
    );
  });
});

function manifestEntry(overrides: Partial<CuratedWallpaper>): CuratedWallpaper {
  return {
    id: "dunes",
    title: "Dunes",
    fullUrl: "https://assets.traycer.ai/start-page/wallpapers/dunes.webp",
    thumbUrl:
      "https://assets.traycer.ai/start-page/wallpapers/dunes-thumb.webp",
    sha256: "a".repeat(64),
    bytes: 1024,
    ...overrides,
  };
}

describe("StartPageSettingsSection: curated wallpaper gallery", () => {
  const dunes = manifestEntry({});
  const ridge = manifestEntry({
    id: "ridge",
    title: "Ridge",
    fullUrl: "https://assets.traycer.ai/start-page/wallpapers/ridge.webp",
    thumbUrl:
      "https://assets.traycer.ai/start-page/wallpapers/ridge-thumb.webp",
  });

  beforeEach(() => {
    wallpaperMocks.image = { url: null, name: null };
    wallpaperMocks.choose.mockReset().mockResolvedValue(undefined);
    wallpaperMocks.remove.mockReset().mockResolvedValue(undefined);
    wallpaperMocks.applyCurated.mockReset().mockResolvedValue(undefined);
    wallpaperMocks.fetchManifest.mockReset().mockResolvedValue([dunes, ridge]);
    wallpaperMocks.toastError.mockReset();
    analyticsMocks.trackSettingChanged.mockReset();
    useSettingsStore.setState({
      startPageWallpaper: null,
      showGreeting: true,
      showRecentHistory: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a tile per manifest entry as a labelled, lazy, referrer-safe image button", async () => {
    renderSection();

    const dunesTile = await screen.findByRole("button", { name: "Dunes" });
    const ridgeTile = screen.getByRole("button", { name: "Ridge" });
    const dunesImg = dunesTile.querySelector("img");
    expect(dunesImg?.getAttribute("loading")).toBe("lazy");
    expect(dunesImg?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(dunesImg?.getAttribute("src")).toBe(dunes.thumbUrl);
    expect(ridgeTile).not.toBeNull();
  });

  it("marks the tile matching the stored curatedId as pressed", async () => {
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "Ridge",
        curatedId: "ridge",
      },
    });
    renderSection();

    const ridgeTile = await screen.findByRole("button", { name: "Ridge" });
    const dunesTile = screen.getByRole("button", { name: "Dunes" });
    expect(ridgeTile.getAttribute("aria-pressed")).toBe("true");
    expect(dunesTile.getAttribute("aria-pressed")).toBe("false");
  });

  it("applies a non-applied tile and tracks the setting on success", async () => {
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });

    fireEvent.click(dunesTile);

    await vi.waitFor(() =>
      expect(wallpaperMocks.applyCurated).toHaveBeenCalledWith(dunes),
    );
    await vi.waitFor(() =>
      expect(analyticsMocks.trackSettingChanged).toHaveBeenCalledWith(
        "appearance",
        "startPageWallpaperCurated",
      ),
    );
  });

  it("no-ops when the already-applied tile is clicked", async () => {
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "Dunes",
        curatedId: "dunes",
      },
    });
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });

    fireEvent.click(dunesTile);

    expect(wallpaperMocks.applyCurated).not.toHaveBeenCalled();
  });

  it("disables and spins the pending tile while its apply is in flight", async () => {
    const apply = { resolve: (): void => undefined };
    wallpaperMocks.applyCurated.mockReturnValue(
      new Promise<void>((resolve) => {
        apply.resolve = () => resolve();
      }),
    );
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });

    fireEvent.click(dunesTile);

    await vi.waitFor(() => expect(dunesTile.matches(":disabled")).toBe(true));
    expect(dunesTile.querySelector('[aria-hidden="true"]')).not.toBeNull();
    apply.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("spins the newest tile when a second apply overlaps the first", async () => {
    const finish: Array<() => void> = [];
    wallpaperMocks.applyCurated.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish.push(() => resolve());
        }),
    );
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });
    const ridgeTile = screen.getByRole("button", { name: "Ridge" });

    fireEvent.click(dunesTile);
    await vi.waitFor(() => expect(dunesTile.matches(":disabled")).toBe(true));
    fireEvent.click(ridgeTile);

    await vi.waitFor(() => expect(ridgeTile.matches(":disabled")).toBe(true));
    expect(dunesTile.matches(":disabled")).toBe(false);
    for (const resolve of finish) resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("aborts an in-flight local pick when a tile is applied", async () => {
    const chosen = { signal: null as AbortSignal | null };
    wallpaperMocks.choose.mockImplementation(
      (_file: File, signal: AbortSignal) => {
        chosen.signal = signal;
        return new Promise<void>(() => undefined);
      },
    );
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });
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

    fireEvent.click(dunesTile);

    expect(chosen.signal?.aborted).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Choose image…" })
        .matches(":disabled"),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(wallpaperMocks.applyCurated).toHaveBeenCalledWith(dunes),
    );
  });

  it("toasts an Error rejection's message", async () => {
    wallpaperMocks.applyCurated.mockRejectedValue(new Error("download failed"));
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });

    fireEvent.click(dunesTile);

    await vi.waitFor(() =>
      expect(wallpaperMocks.toastError).toHaveBeenCalledWith("download failed"),
    );
  });

  it("does not toast an AbortError rejection", async () => {
    wallpaperMocks.applyCurated.mockRejectedValue(
      new DOMException("x", "AbortError"),
    );
    renderSection();
    const dunesTile = await screen.findByRole("button", { name: "Dunes" });

    fireEvent.click(dunesTile);

    await vi.waitFor(() =>
      expect(wallpaperMocks.applyCurated).toHaveBeenCalled(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wallpaperMocks.toastError).not.toHaveBeenCalled();
  });

  it("renders an alert with Retry that refetches the manifest", async () => {
    wallpaperMocks.fetchManifest
      .mockReset()
      .mockRejectedValue(new Error("The wallpaper catalog could not be read."));
    renderSection();

    // The query is configured with `retry: 1` in production code, so the
    // error state is reached only after an initial attempt and one retry -
    // the count at that point is an implementation detail of that policy,
    // not what this test is about. What Retry has to do is issue at least
    // one MORE call than had already happened by the time the alert showed.
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain(
      "The wallpaper catalog could not be read.",
    );
    const callsBeforeRetry = wallpaperMocks.fetchManifest.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() =>
      expect(wallpaperMocks.fetchManifest.mock.calls.length).toBeGreaterThan(
        callsBeforeRetry,
      ),
    );
  });

  it("renders empty state text for an empty manifest", async () => {
    wallpaperMocks.fetchManifest.mockReset().mockResolvedValue([]);
    renderSection();

    expect(await screen.findByText("No wallpapers available.")).not.toBeNull();
  });

  it("refetches the manifest from the refresh button", async () => {
    renderSection();
    await screen.findByRole("button", { name: "Dunes" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh wallpapers" }));

    await vi.waitFor(() =>
      expect(wallpaperMocks.fetchManifest).toHaveBeenCalledTimes(2),
    );
  });
});
