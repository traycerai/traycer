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
  resetRetainedStartPageWallpaperImageForTests,
  useStartPageWallpaperImage,
} from "@/lib/appearance/start-page-wallpaper";
import type { CuratedWallpaper } from "@/lib/appearance/curated-wallpapers";

describe("useStartPageWallpaperImage", () => {
  beforeEach(() => {
    resetRetainedStartPageWallpaperImageForTests();
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

  it("paints the retained image on the first render of a remount", async () => {
    cacheMocks.read.mockResolvedValue(
      new Blob(["bytes"], { type: "image/png" }),
    );
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "horse.png",
        curatedId: null,
      },
    });
    const first = renderHook(() => useStartPageWallpaperImage());
    await waitFor(() =>
      expect(first.result.current.url).toBe("blob:wallpaper"),
    );
    expect(first.result.current.name).toBe("horse.png");
    first.unmount();

    // The remount must not wait on this read. A host switch remounts the
    // start page, and an empty first render is the full-screen flash.
    cacheMocks.read.mockReturnValue(new Promise<Blob>(() => undefined));
    const second = renderHook(() => useStartPageWallpaperImage());
    expect(second.result.current).toEqual({
      url: "blob:wallpaper",
      name: "horse.png",
    });
  });

  it("does not paint a retained image when the wallpaper name changed", async () => {
    cacheMocks.read.mockResolvedValue(
      new Blob(["bytes"], { type: "image/png" }),
    );
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "horse.png",
        curatedId: null,
      },
    });
    const first = renderHook(() => useStartPageWallpaperImage());
    await waitFor(() =>
      expect(first.result.current.url).toBe("blob:wallpaper"),
    );
    first.unmount();

    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "dunes.webp",
        curatedId: "dunes",
      },
    });
    cacheMocks.read.mockReturnValue(new Promise<Blob>(() => undefined));
    const second = renderHook(() => useStartPageWallpaperImage());
    expect(second.result.current).toEqual({ url: null, name: null });
  });

  it("does not paint a retained image when the same name was replaced", async () => {
    cacheMocks.read.mockResolvedValue(
      new Blob(["bytes"], { type: "image/png" }),
    );
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "horse.png",
        curatedId: null,
      },
    });
    const first = renderHook(() => useStartPageWallpaperImage());
    await waitFor(() =>
      expect(first.result.current.url).toBe("blob:wallpaper"),
    );
    first.unmount();

    // Remove bumps the blob revision. Putting the same file name back without
    // a new read must not reuse the previous object URL.
    await act(async () => {
      await removeStartPageWallpaper();
    });
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "horse.png",
        curatedId: null,
      },
    });
    cacheMocks.read.mockReturnValue(new Promise<Blob>(() => undefined));
    const second = renderHook(() => useStartPageWallpaperImage());
    expect(second.result.current).toEqual({ url: null, name: null });
  });

  it("shares one object URL between two mounted readers", async () => {
    let created = 0;
    const revoked = new Set<string>();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created += 1;
      return `blob:shared-${created}`;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
      revoked.add(url);
    });
    let resolveRead: (blob: Blob) => void = () => undefined;
    cacheMocks.read.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveRead = resolve;
      }),
    );
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "shared.png",
        curatedId: null,
      },
    });
    const first = renderHook(() => useStartPageWallpaperImage());
    const second = renderHook(() => useStartPageWallpaperImage());

    act(() => {
      resolveRead(new Blob(["shared"], { type: "image/png" }));
    });

    await waitFor(() => expect(first.result.current.url).toBe("blob:shared-1"));
    expect(second.result.current.url).toBe("blob:shared-1");
    expect(revoked.has("blob:shared-1")).toBe(false);
    expect(created).toBe(1);
  });

  it("rereads a same-name replacement on remount without blanking first", async () => {
    let created = 0;
    const revoked = new Set<string>();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created += 1;
      return `blob:replace-${created}`;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
      revoked.add(url);
    });
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "wallpaper.png",
        curatedId: null,
      },
    });
    cacheMocks.read.mockResolvedValue(
      new Blob(["original"], { type: "image/png" }),
    );
    const first = renderHook(() => useStartPageWallpaperImage());
    await waitFor(() =>
      expect(first.result.current.url).toBe("blob:replace-1"),
    );
    first.unmount();

    cacheMocks.read.mockResolvedValue(
      new Blob(["replacement"], { type: "image/png" }),
    );
    const second = renderHook(() => useStartPageWallpaperImage());
    expect(second.result.current.url).toBe("blob:replace-1");

    await waitFor(() =>
      expect(second.result.current.url).toBe("blob:replace-2"),
    );
    expect(revoked.has("blob:replace-2")).toBe(false);
  });

  it("keeps an in-flight read while another reader is still mounted", async () => {
    let created = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created += 1;
      return `blob:live-${created}`;
    });
    let resolveRead: (blob: Blob) => void = () => undefined;
    cacheMocks.read.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveRead = resolve;
      }),
    );
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "shared.png",
        curatedId: null,
      },
    });
    const first = renderHook(() => useStartPageWallpaperImage());
    const second = renderHook(() => useStartPageWallpaperImage());
    first.unmount();

    act(() => {
      resolveRead(new Blob(["still-live"], { type: "image/png" }));
    });

    await waitFor(() => expect(second.result.current.url).toBe("blob:live-1"));
    expect(cacheMocks.read).toHaveBeenCalledTimes(1);
  });

  it("rereads after a remount inherits a read the previous mount left running", async () => {
    const urls = new Map<string, Blob>();
    let created = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created += 1;
      const url = `blob:orphan-${created}`;
      urls.set(url, blob as Blob);
      return url;
    });
    const original = new Blob(["original"], { type: "image/png" });
    const replacement = new Blob(["replacement"], { type: "image/png" });
    let releaseBytes: (buffer: ArrayBuffer) => void = () => undefined;
    const gated = new Promise<ArrayBuffer>((resolve) => {
      releaseBytes = resolve;
    });
    const originalBytes = await original.arrayBuffer();
    vi.spyOn(original, "arrayBuffer").mockReturnValue(gated);
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "wallpaper.png",
        curatedId: null,
      },
    });
    cacheMocks.read.mockResolvedValueOnce(original);
    const first = renderHook(() => useStartPageWallpaperImage());
    await waitFor(() => expect(cacheMocks.read).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    cacheMocks.read.mockResolvedValue(replacement);
    const second = renderHook(() => useStartPageWallpaperImage());
    await act(async () => {
      releaseBytes(originalBytes.slice(0));
      await Promise.resolve();
    });

    await waitFor(() => {
      const url = second.result.current.url;
      expect(url).not.toBeNull();
      expect(urls.get(url ?? "")).toBe(replacement);
    });
    expect(cacheMocks.read).toHaveBeenCalledTimes(2);
  });
});

function curatedEntry(overrides: Partial<CuratedWallpaper>): CuratedWallpaper {
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

    await applyCuratedStartPageWallpaper(curatedEntry({}));

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

    await applyCuratedStartPageWallpaper(curatedEntry({}));

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

    const applyPromise = applyCuratedStartPageWallpaper(curatedEntry({}));
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

  it("pairs the row with the bytes when the losing apply is the one that wrote them", async () => {
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "old.png",
        curatedId: null,
      },
    });
    const dunesBlob = new Blob(["dunes"], { type: "image/webp" });
    curatedMocks.download.mockImplementation((entry: CuratedWallpaper) =>
      entry.id === "dunes"
        ? Promise.resolve(dunesBlob)
        : Promise.reject(new Error("download failed")),
    );
    imageProcessingMocks.validate.mockResolvedValue({
      width: 100,
      height: 100,
    });
    // The blob write hangs, which is the window the race needs: Dunes is
    // aborted while its bytes are already on their way to the store.
    let finishWrite: () => void = () => undefined;
    cacheMocks.write.mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = () => resolve();
      }),
    );

    const dunesApply = applyCuratedStartPageWallpaper(curatedEntry({}));
    await vi.waitFor(() => expect(cacheMocks.write).toHaveBeenCalledTimes(1));
    const ridgeApply = applyCuratedStartPageWallpaper(
      curatedEntry({ id: "ridge", title: "Ridge" }),
    );

    await expect(ridgeApply).rejects.toThrow("download failed");
    finishWrite();

    await expect(dunesApply).rejects.toMatchObject({ name: "AbortError" });
    // Ridge never got as far as storing anything, so the bytes in the store
    // are Dunes' - and the row has to say so rather than still describing the
    // wallpaper those bytes replaced.
    expect(cacheMocks.write).toHaveBeenCalledTimes(1);
    expect(cacheMocks.write).toHaveBeenCalledWith(
      "start-page-wallpaper",
      dunesBlob,
    );
    expect(useSettingsStore.getState().startPageWallpaper).toMatchObject({
      name: "Dunes",
      curatedId: "dunes",
    });
  });

  it("keeps the previous pair intact when the replacement write fails", async () => {
    useSettingsStore.setState({
      startPageWallpaper: {
        style: "dither",
        intensity: 0.6,
        tintWithAccent: true,
        name: "old.png",
        curatedId: null,
      },
    });
    imageProcessingMocks.process.mockResolvedValue({
      blob: new Blob(["custom"], { type: "image/webp" }),
      width: 800,
      height: 600,
    });
    cacheMocks.write.mockRejectedValue(new Error("quota exceeded"));

    await expect(
      chooseStartPageWallpaper(
        new File(["custom"], "new.png", { type: "image/png" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("quota exceeded");

    // The blob store write is atomic per key, so the old bytes survived a
    // failed replacement - deleting them here is what would strand the row
    // that still describes them.
    expect(cacheMocks.remove).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().startPageWallpaper).toMatchObject({
      name: "old.png",
      curatedId: null,
    });
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
