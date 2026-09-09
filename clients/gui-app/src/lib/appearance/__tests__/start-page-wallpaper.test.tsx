import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings/settings-store";

const cacheMocks = vi.hoisted(() => ({
  read: vi.fn(),
  remove: vi.fn(),
  pin: vi.fn(),
}));

vi.mock("@/lib/appearance/appearance-cache", () => ({
  readAppearanceBlob: cacheMocks.read,
  removeAppearanceBlob: cacheMocks.remove,
  pinGlobalAppearanceBlob: cacheMocks.pin,
  writeAppearanceBlob: vi.fn(),
}));

import { useStartPageWallpaperImage } from "@/lib/appearance/start-page-wallpaper";

describe("useStartPageWallpaperImage", () => {
  beforeEach(() => {
    cacheMocks.read.mockReset();
    cacheMocks.remove.mockResolvedValue(undefined);
    cacheMocks.pin.mockResolvedValue(undefined);
    useSettingsStore.setState({ startPageWallpaper: null });
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      (_blob: Blob | MediaSource) => "blob:wallpaper",
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ startPageWallpaper: null });
    vi.restoreAllMocks();
  });

  it("does not let an older read clear the image loaded by a newer revision", async () => {
    let resolveOld: ((blob: Blob) => void) | null = null;
    const oldRead = new Promise<Blob>((resolve) => {
      resolveOld = resolve;
    });
    const latest = new Blob(["latest"], { type: "image/png" });
    cacheMocks.read.mockReturnValueOnce(oldRead).mockResolvedValueOnce(latest);
    const { result } = renderHook(() => useStartPageWallpaperImage());

    // The name lives on the settings row now (see FIX 3 correction), not
    // sniffed off the blob - setting it is what a real
    // `chooseStartPageWallpaper` write does in the same beat as the blob
    // write, and it is a dependency of the hook's read effect, so this also
    // stands in for the newer revision.
    await act(async () => {
      useSettingsStore.setState({
        startPageWallpaper: {
          style: "dither",
          intensity: 0.6,
          tintWithAccent: true,
          name: "latest.png",
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.name).toBe("latest.png"));
    const currentUrl = result.current.url;

    await act(async () => {
      resolveOld?.(new Blob(["old"], { type: "image/png" }));
      await Promise.resolve();
    });
    expect(result.current).toEqual({ url: currentUrl, name: "latest.png" });
  });
});
