import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings/settings-store";

const cacheMocks = vi.hoisted(() => ({
  read: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
}));

vi.mock("@/lib/appearance/appearance-cache", () => ({
  readAppearanceBlob: cacheMocks.read,
  removeAppearanceBlob: cacheMocks.remove,
  writeAppearanceBlob: cacheMocks.write,
}));

const curatedMocks = vi.hoisted(() => ({
  download: vi.fn(),
}));

vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  downloadCuratedWallpaper: curatedMocks.download,
}));

const imageProcessingMocks = vi.hoisted(() => ({
  validate: vi.fn(),
  process: vi.fn(),
}));

vi.mock("@/lib/appearance/appearance-image-processing", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/appearance/appearance-image-processing")
  >("@/lib/appearance/appearance-image-processing");
  return {
    ...actual,
    validateAppearanceImage: imageProcessingMocks.validate,
    processStartPageWallpaperImage: imageProcessingMocks.process,
  };
});

import {
  applyCuratedStartPageWallpaper,
  chooseStartPageWallpaper,
  removeStartPageWallpaper,
  useStartPageWallpaperImage,
} from "@/lib/appearance/start-page-wallpaper";
import type { CuratedWallpaper } from "@/lib/appearance/curated-wallpapers";

describe("useStartPageWallpaperImage", () => {
  beforeEach(() => {
    cacheMocks.read.mockReset();
    cacheMocks.remove.mockResolvedValue(undefined);
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
          curatedId: null,
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

function curatedEntry(
  overrides: Partial<CuratedWallpaper> = {},
): CuratedWallpaper {
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

function deferredBlob(): {
  readonly promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
} {
  let resolve: (blob: Blob) => void = () => undefined;
  const promise = new Promise<Blob>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("applyCuratedStartPageWallpaper / chooseStartPageWallpaper", () => {
  beforeEach(() => {
    cacheMocks.write.mockReset().mockResolvedValue(undefined);
    cacheMocks.remove.mockReset().mockResolvedValue(undefined);
    curatedMocks.download.mockReset();
    imageProcessingMocks.validate.mockReset();
    imageProcessingMocks.process.mockReset();
    useSettingsStore.setState({ startPageWallpaper: null });
  });

  afterEach(() => {
    useSettingsStore.setState({ startPageWallpaper: null });
  });

  it("stores a blob under the budget verbatim without re-encoding", async () => {
    const blob = new Blob(["verbatim"], { type: "image/webp" });
    curatedMocks.download.mockResolvedValue(blob);
    imageProcessingMocks.validate.mockResolvedValue({
      width: 2560,
      height: 1600,
    });

    await applyCuratedStartPageWallpaper(curatedEntry());

    expect(imageProcessingMocks.process).not.toHaveBeenCalled();
    expect(cacheMocks.write).toHaveBeenCalledWith("start-page-wallpaper", blob);
    expect(useSettingsStore.getState().startPageWallpaper).toEqual({
      style: "dither",
      intensity: 0.6,
      tintWithAccent: true,
      name: "Dunes",
      curatedId: "dunes",
    });
  });

  it("re-encodes a downloaded image whose edge exceeds the stored budget", async () => {
    const downloaded = new Blob(["big"], { type: "image/webp" });
    const reencoded = new Blob(["small"], { type: "image/webp" });
    curatedMocks.download.mockResolvedValue(downloaded);
    imageProcessingMocks.validate.mockResolvedValue({
      width: 4000,
      height: 2000,
    });
    imageProcessingMocks.process.mockResolvedValue({
      blob: reencoded,
      width: 2560,
      height: 1280,
    });

    await applyCuratedStartPageWallpaper(curatedEntry());

    expect(imageProcessingMocks.process).toHaveBeenCalledWith(
      downloaded,
      expect.any(AbortSignal),
    );
    expect(cacheMocks.write).toHaveBeenCalledWith(
      "start-page-wallpaper",
      reencoded,
    );
  });

  it("keeps the existing style, intensity and tint when a wallpaper was already set", async () => {
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "grain",
        intensity: 0.3,
        tintWithAccent: false,
        name: "old.png",
        curatedId: null,
      },
    });
    curatedMocks.download.mockResolvedValue(
      new Blob(["x"], { type: "image/webp" }),
    );
    imageProcessingMocks.validate.mockResolvedValue({
      width: 100,
      height: 100,
    });

    await applyCuratedStartPageWallpaper(
      curatedEntry({ id: "ridge", title: "Ridge" }),
    );

    expect(useSettingsStore.getState().startPageWallpaper).toEqual({
      style: "grain",
      intensity: 0.3,
      tintWithAccent: false,
      name: "Ridge",
      curatedId: "ridge",
    });
  });

  it("aborts an in-flight apply when removeStartPageWallpaper runs, leaving the row null", async () => {
    const deferred = deferredBlob();
    curatedMocks.download.mockReturnValue(deferred.promise);
    imageProcessingMocks.validate.mockResolvedValue({
      width: 100,
      height: 100,
    });

    const applyPromise = applyCuratedStartPageWallpaper(curatedEntry());
    await removeStartPageWallpaper();
    deferred.resolve(new Blob(["x"], { type: "image/webp" }));

    await expect(applyPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(useSettingsStore.getState().startPageWallpaper).toBeNull();
  });

  it("aborts the first apply when a second one starts, and the second lands", async () => {
    const first = deferredBlob();
    const second = deferredBlob();
    curatedMocks.download.mockImplementation((entry: CuratedWallpaper) =>
      entry.id === "first" ? first.promise : second.promise,
    );
    imageProcessingMocks.validate.mockResolvedValue({
      width: 100,
      height: 100,
    });

    const firstApply = applyCuratedStartPageWallpaper(
      curatedEntry({ id: "first", title: "First" }),
    );
    const secondApply = applyCuratedStartPageWallpaper(
      curatedEntry({ id: "second", title: "Second" }),
    );

    second.resolve(new Blob(["s"], { type: "image/webp" }));
    await secondApply;
    first.resolve(new Blob(["f"], { type: "image/webp" }));

    await expect(firstApply).rejects.toMatchObject({ name: "AbortError" });
    expect(useSettingsStore.getState().startPageWallpaper?.curatedId).toBe(
      "second",
    );
  });

  it("writes curatedId: null when choosing a custom file", async () => {
    imageProcessingMocks.process.mockResolvedValue({
      blob: new Blob(["custom"], { type: "image/webp" }),
      width: 800,
      height: 600,
    });

    await chooseStartPageWallpaper(
      new File(["custom"], "custom.png", { type: "image/png" }),
      new AbortController().signal,
    );

    expect(
      useSettingsStore.getState().startPageWallpaper?.curatedId,
    ).toBeNull();
  });
});
