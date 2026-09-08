import { Blob as NodeBlob } from "node:buffer";
import { URL as NodeURL } from "node:url";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import type {
  AppearanceImageRequest,
  ProcessedAppearanceImage,
} from "@/lib/appearance/appearance-image-processing";

/**
 * Only the actual pixel work (the dynamically-imported
 * `runAppearanceImageProcessing`) is faked. `appearance-cache` (real
 * IndexedDB, via the fake-idb harness) and `imageBlobCache` (the real
 * lease/coalesce/grace-release cache) run for real, so the coalescing,
 * cache-reuse, and cancellation behavior asserted below is the actual
 * cache's behavior, not a mock standing in for it.
 */
const preparationMocks = vi.hoisted(() => ({
  runAppearanceImageProcessing:
    vi.fn<
      (
        request: AppearanceImageRequest,
        signal: AbortSignal,
      ) => Promise<ProcessedAppearanceImage>
    >(),
}));
vi.mock(
  "@/lib/appearance/appearance-image-preparation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/appearance/appearance-image-preparation")
      >();
    return {
      ...actual,
      runAppearanceImageProcessing:
        preparationMocks.runAppearanceImageProcessing,
    };
  },
);

type HookModule = typeof import("../use-wallpaper-treatment");
type ImageBlobCacheModule = typeof import("@/lib/attachments/image-blob-cache");

// A statically-imported `imageBlobCache` would be a different singleton than
// the one the freshly `vi.resetModules()`-reimported hook module closes
// over - see `appearance-cache.test.ts`/`use-appearance-assets.test.tsx`'s
// own doc comments on why every test needs a fresh import chain.
let currentImageBlobCache: ImageBlobCacheModule["imageBlobCache"] | null = null;

interface LoadedHook {
  readonly useWallpaperTreatment: HookModule["useWallpaperTreatment"];
  readonly imageBlobCache: ImageBlobCacheModule["imageBlobCache"];
}

async function loadHook(): Promise<LoadedHook> {
  vi.resetModules();
  installFreshIndexedDb();
  preparationMocks.runAppearanceImageProcessing.mockReset();
  const { imageBlobCache } = await import("@/lib/attachments/image-blob-cache");
  currentImageBlobCache = imageBlobCache;
  const mod = await import("../use-wallpaper-treatment");
  return { useWallpaperTreatment: mod.useWallpaperTreatment, imageBlobCache };
}

function processedResult(
  bytes: Uint8Array<ArrayBuffer>,
): ProcessedAppearanceImage {
  return {
    blob: new Blob([bytes], { type: "image/webp" }),
    width: 4,
    height: 4,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * A `Response` body can only be read once - `mockResolvedValue` would hand
 * out the SAME instance (and so the same already-consumed body) to every
 * `fetch()` call, which breaks any test where the hook fetches more than
 * once (two mounts, or a remount). This mints a fresh `Response` per call.
 */
function mockFetchResolving(bytes: Uint8Array<ArrayBuffer>): void {
  vi.mocked(globalThis.fetch).mockImplementation(() =>
    Promise.resolve(
      new Response(bytes, { headers: { "content-type": "image/png" } }),
    ),
  );
}

beforeEach(() => {
  // `idb-keyval`'s structured-clone-based fake store and `Response.blob()`
  // (Node's `undici`) both operate on Node's own `Blob`, a different class
  // than jsdom's ambient `Blob` global - see `appearance-cache.test.ts`.
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", NodeURL);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  currentImageBlobCache?.clear();
  currentImageBlobCache = null;
  vi.unstubAllGlobals();
});

const ORIGINAL_URL = "blob:fake-original";

describe("useWallpaperTreatment: original/texture need no pixel work", () => {
  it("returns the original URL immediately for treatment=original, fetching and processing nothing", async () => {
    const { useWallpaperTreatment } = await loadHook();
    const { result } = renderHook(() =>
      useWallpaperTreatment({
        scope: null,
        originalUrl: ORIGINAL_URL,
        treatment: "original",
        strength: 0,
      }),
    );
    expect(result.current).toBe(ORIGINAL_URL);
    await act(async () => {
      await wait(200);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(
      preparationMocks.runAppearanceImageProcessing,
    ).not.toHaveBeenCalled();
  });

  it("returns the original URL immediately for treatment=texture", async () => {
    const { useWallpaperTreatment } = await loadHook();
    const { result } = renderHook(() =>
      useWallpaperTreatment({
        scope: null,
        originalUrl: ORIGINAL_URL,
        treatment: "texture",
        strength: 0.5,
      }),
    );
    expect(result.current).toBe(ORIGINAL_URL);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns the original URL immediately when dither strength is exactly 0", async () => {
    const { useWallpaperTreatment } = await loadHook();
    const { result } = renderHook(() =>
      useWallpaperTreatment({
        scope: null,
        originalUrl: ORIGINAL_URL,
        treatment: "dither",
        strength: 0,
      }),
    );
    expect(result.current).toBe(ORIGINAL_URL);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("useWallpaperTreatment: dither derivation", () => {
  it("debounces, fetches, derives once, and returns a distinct URL", async () => {
    const { useWallpaperTreatment } = await loadHook();
    mockFetchResolving(new Uint8Array([1, 2, 3]));
    preparationMocks.runAppearanceImageProcessing.mockResolvedValue(
      processedResult(new Uint8Array([9, 9, 9])),
    );

    const { result } = renderHook(() =>
      useWallpaperTreatment({
        scope: null,
        originalUrl: ORIGINAL_URL,
        treatment: "dither",
        strength: 0.5,
      }),
    );
    expect(result.current).toBe(ORIGINAL_URL);

    await waitFor(() => {
      expect(
        preparationMocks.runAppearanceImageProcessing,
      ).toHaveBeenCalledTimes(1);
    });
    const call = preparationMocks.runAppearanceImageProcessing.mock.calls.at(0);
    if (call === undefined) throw new Error("expected a process call");
    const [request] = call;
    expect(request).toMatchObject({ kind: "dither", strength: 0.5 });
    await waitFor(() => {
      expect(result.current).not.toBe(ORIGINAL_URL);
    });
  });

  it("coalesces rapid strength changes before the debounce fires into a single derive of the LAST value", async () => {
    const { useWallpaperTreatment } = await loadHook();
    mockFetchResolving(new Uint8Array([1]));
    preparationMocks.runAppearanceImageProcessing.mockResolvedValue(
      processedResult(new Uint8Array([2])),
    );

    const { rerender } = renderHook(
      (strength: number) =>
        useWallpaperTreatment({
          scope: null,
          originalUrl: ORIGINAL_URL,
          treatment: "dither",
          strength,
        }),
      { initialProps: 0.2 },
    );
    rerender(0.5);
    rerender(0.9);

    await waitFor(() => {
      expect(
        preparationMocks.runAppearanceImageProcessing,
      ).toHaveBeenCalledTimes(1);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = preparationMocks.runAppearanceImageProcessing.mock.calls.at(0);
    if (call === undefined) throw new Error("expected a process call");
    const [request] = call;
    expect(request).toMatchObject({ strength: 0.9 });
  });

  it("serves a second concurrent consumer of the same derived image from cache, without re-deriving", async () => {
    const { useWallpaperTreatment } = await loadHook();
    mockFetchResolving(new Uint8Array([5, 5, 5]));
    preparationMocks.runAppearanceImageProcessing.mockResolvedValue(
      processedResult(new Uint8Array([6, 6, 6])),
    );

    const input = {
      scope: null,
      originalUrl: ORIGINAL_URL,
      treatment: "dither" as const,
      strength: 0.4,
    };
    const first = renderHook(() => useWallpaperTreatment(input));
    const second = renderHook(() => useWallpaperTreatment(input));

    await waitFor(() => {
      expect(first.result.current).not.toBe(ORIGINAL_URL);
      expect(second.result.current).not.toBe(ORIGINAL_URL);
    });
    expect(preparationMocks.runAppearanceImageProcessing).toHaveBeenCalledTimes(
      1,
    );
    expect(first.result.current).toBe(second.result.current);
  });

  it("cancels the pending derivation on unmount before the debounce fires", async () => {
    const { useWallpaperTreatment } = await loadHook();
    const { unmount } = renderHook(() =>
      useWallpaperTreatment({
        scope: null,
        originalUrl: ORIGINAL_URL,
        treatment: "dither",
        strength: 0.3,
      }),
    );
    unmount();

    await wait(200); // longer than the 100ms debounce, if it had wrongly fired

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(
      preparationMocks.runAppearanceImageProcessing,
    ).not.toHaveBeenCalled();
  });

  it("aborts an in-flight derivation superseded mid-flight, and a late-resolving stale result never repaints", async () => {
    const { useWallpaperTreatment } = await loadHook();
    mockFetchResolving(new Uint8Array([7]));
    const pending: Array<{
      readonly signal: AbortSignal;
      readonly resolve: (value: ProcessedAppearanceImage) => void;
    }> = [];
    preparationMocks.runAppearanceImageProcessing.mockImplementation(
      (_request: AppearanceImageRequest, signal: AbortSignal) =>
        new Promise<ProcessedAppearanceImage>((resolve) => {
          pending.push({ signal, resolve });
        }),
    );

    const { rerender, result } = renderHook(
      (strength: number) =>
        useWallpaperTreatment({
          scope: null,
          originalUrl: ORIGINAL_URL,
          treatment: "dither",
          strength,
        }),
      { initialProps: 0.2 },
    );

    await waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    const callA = pending.at(0);
    if (callA === undefined) throw new Error("expected derivation A");
    expect(callA.signal.aborted).toBe(false);

    rerender(0.9); // supersedes A before it resolves
    expect(callA.signal.aborted).toBe(true);

    await waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    const callB = pending.at(1);
    if (callB === undefined) throw new Error("expected derivation B");
    callB.resolve(processedResult(new Uint8Array([8])));
    await waitFor(() => {
      expect(result.current).not.toBe(ORIGINAL_URL);
    });
    const urlAfterB = result.current;

    callA.resolve(processedResult(new Uint8Array([9]))); // late, stale
    await wait(200);
    expect(result.current).toBe(urlAfterB);
  });

  it("reuses a persisted derived image after imageBlobCache.clear() and remount, without re-deriving", async () => {
    const { useWallpaperTreatment, imageBlobCache } = await loadHook();
    mockFetchResolving(new Uint8Array([3, 3, 3]));
    preparationMocks.runAppearanceImageProcessing.mockResolvedValue(
      processedResult(new Uint8Array([4, 4, 4])),
    );

    const input = {
      scope: null,
      originalUrl: ORIGINAL_URL,
      treatment: "dither" as const,
      strength: 0.6,
    };
    const first = renderHook(() => useWallpaperTreatment(input));
    await waitFor(() => {
      expect(first.result.current).not.toBe(ORIGINAL_URL);
    });
    expect(preparationMocks.runAppearanceImageProcessing).toHaveBeenCalledTimes(
      1,
    );
    first.unmount();
    imageBlobCache.clear();

    const second = renderHook(() => useWallpaperTreatment(input));
    await waitFor(() => {
      expect(second.result.current).not.toBe(ORIGINAL_URL);
    });
    // The persisted (IndexedDB) derived blob from the first mount is reused;
    // `imageBlobCache.clear()` only drops the in-memory blob-URL cache.
    expect(preparationMocks.runAppearanceImageProcessing).toHaveBeenCalledTimes(
      1,
    );
  });
});
