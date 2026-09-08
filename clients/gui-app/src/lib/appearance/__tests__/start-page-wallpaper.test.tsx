import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  saveStartPageWallpaper,
  useStartPageWallpaperImage,
} from "@/lib/appearance/start-page-wallpaper";

describe("useStartPageWallpaperImage", () => {
  beforeEach(() => {
    cacheMocks.read.mockReset();
    cacheMocks.remove.mockResolvedValue(undefined);
    cacheMocks.pin.mockResolvedValue(undefined);
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      (_blob: Blob | MediaSource) => "blob:wallpaper",
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not let an older read clear the image loaded by a newer revision", async () => {
    let resolveOld: ((blob: Blob) => void) | null = null;
    const oldRead = new Promise<Blob>((resolve) => {
      resolveOld = resolve;
    });
    const latest = new File(["latest"], "latest.png", { type: "image/png" });
    cacheMocks.read.mockReturnValueOnce(oldRead).mockResolvedValueOnce(latest);
    const { result } = renderHook(() => useStartPageWallpaperImage());

    await act(async () => {
      await saveStartPageWallpaper(null);
    });
    await waitFor(() => expect(result.current.name).toBe("latest.png"));
    const currentUrl = result.current.url;

    await act(async () => {
      resolveOld?.(new File(["old"], "old.png", { type: "image/png" }));
      await Promise.resolve();
    });
    expect(result.current).toEqual({ url: currentUrl, name: "latest.png" });
  });
});
