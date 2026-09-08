import { useState, type ReactNode } from "react";
import { Blob as NodeBlob } from "node:buffer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { IMAGE_FETCH_MAX_ATTEMPTS } from "@/lib/attachments/use-image-blob-url";
import type { UseFileAssetResult } from "@/hooks/assets/use-file-asset";
import type { GlobalWallpaper } from "@/stores/settings/settings-store";

/**
 * `useHostFileAsset` (the "live" host stream) is mocked wholesale here - its
 * own coalescing/race behavior is `use-file-asset.test.tsx`'s job. What this
 * file owns is the layer ABOVE it: account-scope gating, cache write-through,
 * cached-vs-live precedence, decode-failure cache eviction, and the global
 * wallpaper save flow.
 */
const hostFileAssetMock = vi.hoisted(() => ({
  calls: [] as Array<{
    hostId: string | null;
    request: unknown;
    focused: boolean;
  }>,
  result: {
    status: "loading",
    url: null,
    meta: null,
    reason: null,
    totalBytes: null,
    servedFromCache: false,
    reportDecodeFailure: () => {},
  } as UseFileAssetResult,
}));
vi.mock("@/hooks/assets/use-file-asset", () => ({
  useHostFileAsset: (args: {
    hostId: string | null;
    request: unknown;
    focused: boolean;
  }) => {
    hostFileAssetMock.calls.push(args);
    return hostFileAssetMock.result;
  },
}));

type AssetsModule = typeof import("../use-appearance-assets");
type CacheModule = typeof import("@/lib/appearance/appearance-cache");
type AuthModule = typeof import("@/stores/auth/auth-store");
type SettingsModule = typeof import("@/stores/settings/settings-store");
type ImageBlobCacheModule = typeof import("@/lib/attachments/image-blob-cache");

// Set by `loadHooks()` each test, read by the top-level `afterEach` below - a
// statically-imported `imageBlobCache` would be a DIFFERENT singleton than
// the one the freshly `vi.resetModules()`-reimported hook module actually
// uses, so cleanup/spies must always go through THIS test's own instance.
let currentImageBlobCache: ImageBlobCacheModule["imageBlobCache"] | null = null;

/**
 * `appearance-cache.ts` opens its IndexedDB store and subscribes to the auth
 * store once, at import time (see `appearance-cache.test.ts`'s own doc
 * comment) - so every test needs a fresh `indexedDB` AND a fresh dynamic
 * import of every module in this dependency chain together, or the hook
 * module under test would close over a STALE cache/auth-store/image-blob-
 * cache instance.
 */
async function loadHooks(): Promise<{
  readonly hooks: AssetsModule;
  readonly cache: CacheModule;
  readonly authStore: AuthModule["useAuthStore"];
  readonly settingsStore: SettingsModule["useSettingsStore"];
  readonly imageBlobCache: ImageBlobCacheModule["imageBlobCache"];
}> {
  vi.resetModules();
  installFreshIndexedDb();
  hostFileAssetMock.calls = [];
  hostFileAssetMock.result = {
    status: "loading",
    url: null,
    meta: null,
    reason: null,
    totalBytes: null,
    servedFromCache: false,
    reportDecodeFailure: () => {},
  };
  const { useAuthStore } = await import("@/stores/auth/auth-store");
  const { useSettingsStore } = await import("@/stores/settings/settings-store");
  const cache = await import("@/lib/appearance/appearance-cache");
  const { imageBlobCache } = await import("@/lib/attachments/image-blob-cache");
  currentImageBlobCache = imageBlobCache;
  const hooks = await import("../use-appearance-assets");
  return {
    hooks,
    cache,
    authStore: useAuthStore,
    settingsStore: useSettingsStore,
    imageBlobCache,
  };
}

function signIn(authStore: AuthModule["useAuthStore"], userId: string): void {
  authStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  );
}

const SCOPE = {
  accountId: "acct-1",
  hostId: "host-1",
  canonicalSourceRoot: "/repo/root",
};

afterEach(() => {
  cleanup();
  currentImageBlobCache?.clear();
  currentImageBlobCache = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAppearanceAsset: account-scope gating", () => {
  it("never asks the live host for a project asset scoped to an account other than the signed-in one", async () => {
    const { hooks, authStore } = await loadHooks();
    signIn(authStore, "acct-2");

    const { result } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        focused: true,
        refreshKey: 0,
      }),
    );

    expect(result.current.url).toBeNull();
    const lastCall = hostFileAssetMock.calls.at(-1);
    expect(lastCall?.request).toBeNull();
  });

  it("asks the live host for a project asset scoped to the signed-in account", async () => {
    const { hooks, authStore } = await loadHooks();
    signIn(authStore, "acct-1");

    renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        focused: true,
        refreshKey: 0,
      }),
    );

    const lastCall = hostFileAssetMock.calls.at(-1);
    expect(lastCall?.request).toMatchObject({
      method: "workspace",
      workspacePath: SCOPE.canonicalSourceRoot,
      filePath: ".traycer/appearance/bg.png",
    });
  });

  it("never asks the live host for a global (scope null) asset - it has no workspace to read it from", async () => {
    // A global wallpaper is a locally uploaded image with no host/workspace
    // of its own (see `useSaveGlobalAppearance`'s `writeAppearanceBlob(null,
    // ...)`), so it resolves purely from the local appearance cache.
    const { hooks, authStore } = await loadHooks();
    signIn(authStore, "acct-1");

    renderHook(() =>
      hooks.useAppearanceAsset({
        scope: null,
        path: "global-bg.png",
        focused: true,
        refreshKey: 0,
      }),
    );

    const lastCall = hostFileAssetMock.calls.at(-1);
    expect(lastCall?.hostId).toBeNull();
    expect(lastCall?.request).toBeNull();
  });
});

describe("useAppearanceAsset: live/cache precedence and write-through", () => {
  // `Response.blob()` (Node's `undici`) and the fake IndexedDB's real
  // `structuredClone` both operate on Node's OWN `Blob` (from `node:buffer`),
  // which is a different class than jsdom's ambient `Blob` global - a blob
  // fetched via `Response` and round-tripped through the cache fails
  // `instanceof Blob` against whichever class was in scope when the check
  // ran. Stubbing the global to Node's `Blob` for this describe's tests
  // makes every `new Blob(...)` fixture, `Response.blob()`'s output, and
  // `appearance-cache.ts`'s own `instanceof Blob` check agree on one class.
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers a ready live URL over a cached one", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceBlob(
      SCOPE,
      "appearance/bg.png",
      new Blob([new Uint8Array([9, 9])], { type: "image/png" }),
    );
    hostFileAssetMock.result = {
      status: "ready",
      url: "blob:live-url",
      meta: null,
      reason: null,
      totalBytes: 2,
      servedFromCache: false,
      reportDecodeFailure: () => {},
    };

    const { result } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        focused: true,
        refreshKey: 0,
      }),
    );

    await waitFor(() => expect(result.current.url).toBe("blob:live-url"));
  });

  it("writes the live-resolved bytes back into the appearance cache", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new Blob([new Uint8Array([5, 6, 7])], { type: "image/png" }),
          ),
        ),
      ),
    );
    hostFileAssetMock.result = {
      status: "ready",
      url: "blob:live-url",
      meta: null,
      reason: null,
      totalBytes: 3,
      servedFromCache: false,
      reportDecodeFailure: () => {},
    };

    renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        focused: true,
        refreshKey: 0,
      }),
    );

    await waitFor(async () => {
      expect(
        await cache.readAppearanceBlob(SCOPE, "appearance/bg.png"),
      ).not.toBeNull();
    });
  });

  it("reportDecodeFailure discards the cached blob and forces the asset unavailable", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceBlob(
      SCOPE,
      "appearance/bg.png",
      new Blob([new Uint8Array([1])], { type: "image/png" }),
    );
    const liveReportDecodeFailure = vi.fn();
    hostFileAssetMock.result = {
      status: "ready",
      url: "blob:live-url",
      meta: null,
      reason: null,
      totalBytes: 1,
      servedFromCache: false,
      reportDecodeFailure: liveReportDecodeFailure,
    };

    const { result } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        focused: true,
        refreshKey: 0,
      }),
    );
    await waitFor(() => expect(result.current.url).toBe("blob:live-url"));

    act(() => {
      result.current.reportDecodeFailure();
    });

    expect(liveReportDecodeFailure).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect(
        await cache.readAppearanceBlob(SCOPE, "appearance/bg.png"),
      ).toBeNull();
    });
  });
});

describe("useAppearanceAsset: offline fallback re-acquires the newest live bytes (fallback-lease regression)", () => {
  // Same Node-vs-jsdom `Blob` realm mismatch as the write-through describe
  // above: every live fetch here goes through `Response`, so the global must
  // be Node's own `Blob` for the cache's `instanceof` check and the fake
  // IndexedDB's `structuredClone` round-trip to agree.
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function markedBlob(byte: number, marker: string): Blob {
    return new Blob([new Uint8Array([byte])], {
      type: `image/png;marker=${marker}`,
    });
  }

  function liveState(partial: Partial<UseFileAssetResult>): UseFileAssetResult {
    return {
      status: "loading",
      url: null,
      meta: null,
      reason: null,
      totalBytes: null,
      servedFromCache: false,
      reportDecodeFailure: () => {},
      ...partial,
    };
  }

  /**
   * `image-blob-cache.ts` types a Blob's create-time URL from its (possibly
   * fetcher-overridden) mediaType - tagging each test blob's `type` with a
   * marker lets these tests read the marker back off the resulting `blob:`
   * URL SYNCHRONOUSLY, without an async `Blob.arrayBuffer()` round trip.
   */
  function installCreateObjectUrlMock(): () => void {
    const originalCreate = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL",
    );
    const originalRevoke = Object.getOwnPropertyDescriptor(
      URL,
      "revokeObjectURL",
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: (blob: Blob) => `blob:${blob.type}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => {},
    });
    return () => {
      if (originalCreate !== undefined)
        Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke !== undefined)
        Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    };
  }

  it("cached A, live serves B, then offline - the fallback shows B, never the original A lease", async () => {
    const restore = installCreateObjectUrlMock();
    try {
      const { hooks, cache, authStore } = await loadHooks();
      signIn(authStore, "acct-1");
      await cache.writeAppearanceBlob(SCOPE, "bg.png", markedBlob(1, "a"));

      const { result, rerender } = renderHook(() =>
        hooks.useAppearanceAsset({
          scope: SCOPE,
          path: "bg.png",
          focused: true,
          refreshKey: 0,
        }),
      );
      await waitFor(() =>
        expect(result.current.url).toBe("blob:image/png;marker=a"),
      );

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response(markedBlob(2, "b"))),
        ),
      );
      hostFileAssetMock.result = liveState({
        status: "ready",
        url: "blob:live-b",
        totalBytes: 1,
      });
      rerender();
      expect(result.current.url).toBe("blob:live-b");
      await waitFor(async () => {
        expect(await cache.readAppearanceBlob(SCOPE, "bg.png")).not.toBeNull();
      });

      // "Offline": the live source drops back to loading.
      hostFileAssetMock.result = liveState({});
      rerender();

      await waitFor(() =>
        expect(result.current.url).toBe("blob:image/png;marker=b"),
      );
    } finally {
      restore();
    }
  });

  it("cold cache miss, live serves B, then offline - the fallback resolves to B", async () => {
    const restore = installCreateObjectUrlMock();
    try {
      const { hooks, cache, authStore } = await loadHooks();
      signIn(authStore, "acct-1");
      const readBlobSpy = vi.spyOn(cache, "readAppearanceBlob");

      const { result, rerender } = renderHook(() =>
        hooks.useAppearanceAsset({
          scope: SCOPE,
          path: "bg.png",
          focused: true,
          refreshKey: 0,
        }),
      );
      expect(result.current.url).toBeNull();

      // Exhaust the cached path's retry budget deterministically (observed via
      // its own `readAppearanceBlob` call count, not a sleep) BEFORE
      // introducing live B - otherwise a lucky late cached-path retry could
      // pick up B through the SAME re-fetch this fix has nothing to do with,
      // letting the test pass for the wrong reason.
      await waitFor(
        () =>
          expect(readBlobSpy).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS),
        { timeout: 5_000 },
      );
      // A call count alone only proves the final attempt STARTED - awaiting
      // its own returned promise proves that lookup actually FINISHED (with
      // a genuine miss) before B exists, so no in-flight read can discover B
      // after the fact.
      const finalAttempt = readBlobSpy.mock.results.at(-1);
      if (finalAttempt === undefined || finalAttempt.type !== "return")
        throw new Error(
          "expected the final cached-path read attempt to have returned a promise",
        );
      await expect(finalAttempt.value).resolves.toBeNull();

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response(markedBlob(2, "b"))),
        ),
      );
      hostFileAssetMock.result = liveState({
        status: "ready",
        url: "blob:live-b",
        totalBytes: 1,
      });
      rerender();
      await waitFor(async () => {
        expect(await cache.readAppearanceBlob(SCOPE, "bg.png")).not.toBeNull();
      });

      hostFileAssetMock.result = liveState({});
      rerender();

      await waitFor(() =>
        expect(result.current.url).toBe("blob:image/png;marker=b"),
      );
    } finally {
      restore();
    }
  }, 10_000);

  it("a stale decode-failure callback captured while A was displayed cannot discard B once B is displayed", async () => {
    const restore = installCreateObjectUrlMock();
    try {
      const { hooks, cache, authStore, imageBlobCache } = await loadHooks();
      signIn(authStore, "acct-1");
      await cache.writeAppearanceBlob(SCOPE, "bg.png", markedBlob(1, "a"));

      const { result, rerender } = renderHook(() =>
        hooks.useAppearanceAsset({
          scope: SCOPE,
          path: "bg.png",
          focused: true,
          refreshKey: 0,
        }),
      );
      await waitFor(() =>
        expect(result.current.url).toBe("blob:image/png;marker=a"),
      );
      const staleReportDecodeFailure = result.current.reportDecodeFailure;

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response(markedBlob(2, "b"))),
        ),
      );
      hostFileAssetMock.result = liveState({
        status: "ready",
        url: "blob:live-b",
        totalBytes: 1,
      });
      rerender();
      await waitFor(async () => {
        expect(await cache.readAppearanceBlob(SCOPE, "bg.png")).not.toBeNull();
      });
      expect(result.current.url).toBe("blob:live-b");

      const removeSpy = vi.spyOn(cache, "removeAppearanceBlob");
      const discardSpy = vi.spyOn(imageBlobCache, "discard");
      act(() => {
        staleReportDecodeFailure();
      });

      expect(removeSpy).not.toHaveBeenCalled();
      expect(discardSpy).not.toHaveBeenCalled();
      expect(result.current.url).toBe("blob:live-b");
      const stillCached = await cache.readAppearanceBlob(SCOPE, "bg.png");
      expect(stillCached?.type).toBe("image/png;marker=b");
    } finally {
      restore();
    }
  });
});

describe("useResolvedAppearanceAssets: wallpaper precedence", () => {
  it("suppresses every wallpaper URL when the project explicitly sets 'none'", async () => {
    const { hooks, authStore, settingsStore } = await loadHooks();
    signIn(authStore, "acct-1");
    settingsStore.setState({
      globalWallpaper: {
        kind: "image",
        path: "global.png",
        focalPoint: [0.5, 0.5],
        treatment: "original",
        dimming: 0,
        strength: 1,
      },
    });

    const { result } = renderHook(() =>
      hooks.useResolvedAppearanceAssets({
        scope: SCOPE,
        appearance: { version: 1, wallpaper: { kind: "none" } },
        focused: true,
        refreshKey: 0,
      }),
    );

    expect(result.current.wallpaperUrl).toBeNull();
    expect(result.current.wallpaper).toEqual({ kind: "none" });
  });

  it("falls back to the global wallpaper when the project has none set", async () => {
    const { hooks, authStore, settingsStore } = await loadHooks();
    signIn(authStore, "acct-1");
    const globalWallpaper = {
      kind: "image",
      path: "global.png",
      focalPoint: [0.5, 0.5],
      treatment: "original",
      dimming: 0,
      strength: 1,
    } satisfies GlobalWallpaper;
    settingsStore.setState({ globalWallpaper });
    hostFileAssetMock.result = {
      status: "ready",
      url: "blob:global-url",
      meta: null,
      reason: null,
      totalBytes: null,
      servedFromCache: false,
      reportDecodeFailure: () => {},
    };

    const { result } = renderHook(() =>
      hooks.useResolvedAppearanceAssets({
        scope: SCOPE,
        appearance: null,
        focused: true,
        refreshKey: 0,
      }),
    );

    await waitFor(() =>
      expect(result.current.wallpaperUrl).toBe("blob:global-url"),
    );
    expect(result.current.wallpaper).toEqual(globalWallpaper);
  });
});

describe("useSaveGlobalAppearance", () => {
  it("writes the blob, pins it, then commits settings - in that order", async () => {
    const { hooks, cache, authStore, settingsStore } = await loadHooks();
    signIn(authStore, "acct-1");
    const order: string[] = [];
    const writeSpy = vi
      .spyOn(cache, "writeAppearanceBlob")
      .mockImplementation(() => {
        order.push("write");
        return Promise.resolve();
      });
    const pinSpy = vi
      .spyOn(cache, "pinGlobalAppearanceBlob")
      .mockImplementation(() => {
        order.push("pin");
        return Promise.resolve();
      });

    const { result } = renderHook(() => hooks.useSaveGlobalAppearance(), {
      wrapper: Wrapper,
    });
    const wallpaper = {
      kind: "image",
      path: "global.png",
      focalPoint: [0.5, 0.5],
      treatment: "original",
      dimming: 0,
      strength: 1,
    } satisfies GlobalWallpaper;
    await act(async () => {
      await result.current.mutateAsync({
        wallpaper,
        blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
        showGreeting: false,
        showRecentHistory: false,
      });
    });

    expect(order).toEqual(["write", "pin"]);
    expect(writeSpy).toHaveBeenCalledWith(null, "global.png", expect.any(Blob));
    expect(pinSpy).toHaveBeenCalledWith("global.png");
    expect(settingsStore.getState().globalWallpaper).toEqual(wallpaper);
    expect(settingsStore.getState().showGreeting).toBe(false);
    expect(settingsStore.getState().showRecentHistory).toBe(false);
  });

  it("unpins (kind: 'none') without ever writing a blob", async () => {
    const { hooks, cache, authStore, settingsStore } = await loadHooks();
    signIn(authStore, "acct-1");
    const writeSpy = vi.spyOn(cache, "writeAppearanceBlob");
    const pinSpy = vi
      .spyOn(cache, "pinGlobalAppearanceBlob")
      .mockResolvedValue(undefined);

    const { result } = renderHook(() => hooks.useSaveGlobalAppearance(), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        wallpaper: { kind: "none" },
        blob: null,
        showGreeting: true,
        showRecentHistory: true,
      });
    });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(pinSpy).toHaveBeenCalledWith(null);
    expect(settingsStore.getState().globalWallpaper).toEqual({ kind: "none" });
  });

  it("refuses to commit settings when the appearance cache was wiped mid-save (a sign-out wipe raced the pin)", async () => {
    // The saved wallpaper is GLOBAL (scope null), and a null-scope session is
    // deliberately immune to an account switch (see
    // `appearance-cache.test.ts`'s "keeps a global session current across
    // account switches") - only `clearAppearanceCache()` (the sign-out wipe)
    // can invalidate it, so that is what this test races against the pin.
    const { hooks, cache, authStore, settingsStore } = await loadHooks();
    signIn(authStore, "acct-1");
    vi.spyOn(cache, "writeAppearanceBlob").mockResolvedValue(undefined);
    vi.spyOn(cache, "pinGlobalAppearanceBlob").mockImplementation(async () => {
      await cache.clearAppearanceCache();
    });
    settingsStore.setState({ showGreeting: true });

    const { result } = renderHook(() => hooks.useSaveGlobalAppearance(), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          wallpaper: { kind: "none" },
          blob: null,
          showGreeting: false,
          showRecentHistory: false,
        }),
      ).rejects.toThrow();
    });

    // The stale-session guard fired before the settings write - the earlier
    // value must survive untouched.
    expect(settingsStore.getState().showGreeting).toBe(true);
  });
});
