import { useState, type ReactNode } from "react";
import { Blob as NodeBlob } from "node:buffer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { IMAGE_FETCH_MAX_ATTEMPTS } from "@/lib/attachments/use-image-blob-url";
import type { UseFileAssetResult } from "@/hooks/assets/use-file-asset";
import type { GlobalWallpaper } from "@/stores/settings/settings-store";
import type { DecodedBitmap } from "@/lib/images/bitmap-codec";
import type { AppearanceScope } from "@/lib/appearance/appearance-cache";
import {
  realPng1x1,
  realPng1x1Alt,
  animatedPng1x1,
  oversizedBytes,
} from "@/lib/appearance/__tests__/appearance-image-fixtures";
import {
  MAX_APPEARANCE_ICON_BYTES,
  MAX_APPEARANCE_WALLPAPER_BYTES,
  type AppearanceUpload,
} from "@traycer/protocol/host/workspace/appearance-schemas";

/**
 * `useHostFileAsset` (the "live" host stream) is mocked wholesale here - its
 * own coalescing/race behavior is `use-file-asset.test.tsx`'s job. What this
 * file owns is the layer ABOVE it: account-scope gating, cache write-through,
 * cached-vs-live precedence, rejected-replacement retention of last-known-
 * good artwork, decode-failure cache eviction, and the global wallpaper save
 * flow.
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

/**
 * `validateAppearanceAssetBlob` decodes every admitted blob through
 * `decodeBitmap` (a real `createImageBitmap`) before accepting it - jsdom has
 * no image decoder, so this graphics boundary needs its own fake here rather
 * than relying on the ambient `createImageBitmap` stub in
 * `__tests__/test-browser-apis.ts` (that stub's `close` isn't a spy, and
 * tests below need to defer/reject a specific decode). Header/size/static
 * validation (`image-size`, `assertStaticAppearanceImage`, the byte sniffer)
 * all stay real.
 */
const bitmapCodecMock = vi.hoisted(() => ({
  decodeBitmap: vi.fn<(blob: Blob) => Promise<DecodedBitmap>>(),
}));
vi.mock("@/lib/images/bitmap-codec", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/images/bitmap-codec")>();
  return { ...actual, decodeBitmap: bitmapCodecMock.decodeBitmap };
});

function fakeBitmap(): {
  readonly bitmap: DecodedBitmap;
  readonly close: Mock<() => void>;
} {
  const close = vi.fn<() => void>();
  return {
    bitmap: {
      width: 1,
      height: 1,
      source: document.createElement("canvas"),
      close,
    },
    close,
  };
}

/**
 * A decode that never settles until the test resolves it itself, plus an
 * `entered` signal that fires the moment `decodeBitmap` is actually CALLED -
 * distinct from settlement, so a test can assert "still showing last-known-
 * good" at the instant a candidate's decode is genuinely in flight, not
 * merely scheduled.
 */
function pendingDecode(): {
  readonly entered: Promise<void>;
  readonly close: Mock<() => void>;
  readonly resolve: () => void;
  /** Queues this pending decode for the NEXT `decodeBitmap` call only. */
  readonly install: () => void;
} {
  const { bitmap, close } = fakeBitmap();
  let resolvePromise: ((value: DecodedBitmap) => void) | null = null;
  const promise = new Promise<DecodedBitmap>((resolve) => {
    resolvePromise = resolve;
  });
  let resolveEntered: (() => void) | null = null;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  return {
    entered,
    close,
    resolve: () => resolvePromise?.(bitmap),
    install: () => {
      bitmapCodecMock.decodeBitmap.mockImplementationOnce(async () => {
        resolveEntered?.();
        return promise;
      });
    },
  };
}

/**
 * Wraps the REAL `validateAppearanceAssetBlob` so a test can await the exact
 * moment a specific candidate's validation SETTLES (not just "some time has
 * passed"), while rethrowing whatever it actually threw - a `waitFor` on the
 * hook's downstream state is a race against the async fetch/validate chain
 * and can pass before that chain has even started; this is a real barrier.
 */
async function installValidationBarrier(): Promise<{
  readonly outcomes: Array<
    Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }>
  >;
}> {
  const validationModule =
    await import("@/lib/appearance/appearance-asset-validation");
  const original = validationModule.validateAppearanceAssetBlob;
  const outcomes: Array<
    Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }>
  > = [];
  vi.spyOn(validationModule, "validateAppearanceAssetBlob").mockImplementation(
    (blob, target) => {
      const settled = original(blob, target).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      outcomes.push(settled);
      return settled.then((outcome) => {
        if (outcome.status === "rejected") throw outcome.error;
      });
    },
  );
  return { outcomes };
}

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
  bitmapCodecMock.decodeBitmap.mockReset();
  bitmapCodecMock.decodeBitmap.mockImplementation(() =>
    Promise.resolve(fakeBitmap().bitmap),
  );
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

function pngBlob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: "image/png" });
}

/** Reads back a persisted blob's bytes, narrowing the null case with a real check instead of `!`. */
async function readPersistedBytes(
  cache: CacheModule,
  scope: AppearanceScope | null,
  path: string,
): Promise<Uint8Array> {
  const persisted = await cache.readAppearanceBlob(scope, path);
  if (persisted === null)
    throw new Error(`expected a persisted appearance blob at "${path}"`);
  return new Uint8Array(await persisted.arrayBuffer());
}

/**
 * jsdom implements no `URL.createObjectURL`/`revokeObjectURL` at all (unlike
 * `createImageBitmap`, there is no ambient polyfill for it in
 * `__tests__/test-browser-apis.ts`), yet the real `imageBlobCache` singleton
 * this hook uses calls it directly on every admitted blob. A plain
 * incrementing id is enough here - no test below reads content back off the
 * URL string itself, only via `cache.readAppearanceBlob`.
 */
function installCreateObjectUrlMock(): () => void {
  let counter = 0;
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
    value: (_blob: Blob) => `blob:${counter++}`,
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

let restoreCreateObjectUrl: (() => void) | null = null;

beforeEach(() => {
  // fake-indexeddb uses Node structuredClone, which cannot clone jsdom Blobs.
  vi.stubGlobal("Blob", NodeBlob);
  restoreCreateObjectUrl = installCreateObjectUrlMock();
});

afterEach(() => {
  cleanup();
  currentImageBlobCache?.clear();
  currentImageBlobCache = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreCreateObjectUrl?.();
  restoreCreateObjectUrl = null;
});

describe("useAppearanceAsset: account-scope gating", () => {
  it("never asks the live host for a project asset scoped to an account other than the signed-in one", async () => {
    const { hooks, authStore } = await loadHooks();
    signIn(authStore, "acct-2");

    const { result } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        target: "wallpaper",
        rejected: false,
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
        target: "wallpaper",
        rejected: false,
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

  it("never asks the live host for a rejected field, and never for a global (scope null) asset", async () => {
    // A rejected field (host-flagged issue) has nothing to stream, and a
    // global wallpaper is a locally uploaded image with no host/workspace of
    // its own (see `useSaveGlobalAppearance`'s `writeAppearanceBlob(null,
    // ...)`) - both resolve purely from the local appearance cache.
    const { hooks, authStore } = await loadHooks();
    signIn(authStore, "acct-1");

    renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        target: "wallpaper",
        rejected: true,
        focused: true,
        refreshKey: 0,
      }),
    );
    expect(hostFileAssetMock.calls.at(-1)?.request).toBeNull();

    renderHook(() =>
      hooks.useAppearanceAsset({
        scope: null,
        path: "global-bg.png",
        target: "wallpaper",
        rejected: false,
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

  it("accepts a validated live image over a cached one, never exposes the raw live URL, and writes it back to the cache", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceBlob(
      SCOPE,
      "appearance/bg.png",
      pngBlob(realPng1x1()),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(pngBlob(realPng1x1Alt()))),
      ),
    );
    const liveReportDecodeFailure = vi.fn();
    hostFileAssetMock.result = liveState({
      status: "ready",
      url: "blob:live-url",
      totalBytes: realPng1x1Alt().byteLength,
      reportDecodeFailure: liveReportDecodeFailure,
    });

    const { result } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        target: "wallpaper",
        rejected: false,
        focused: true,
        refreshKey: 0,
      }),
    );

    await waitFor(async () => {
      const bytes = await readPersistedBytes(cache, SCOPE, "appearance/bg.png");
      expect(bytes).toEqual(realPng1x1Alt());
    });
    // Never the generic host stream URL directly - only an admitted,
    // cache-backed lease is ever displayed.
    expect(result.current.url).not.toBeNull();
    expect(result.current.url).not.toBe("blob:live-url");

    act(() => {
      result.current.reportDecodeFailure();
    });
    expect(liveReportDecodeFailure).toHaveBeenCalledTimes(1);
  });

  it("reportDecodeFailure drops the displayed lease but keeps the persisted blob for a later attempt", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceBlob(
      SCOPE,
      "appearance/bg.png",
      pngBlob(realPng1x1()),
    );

    const { result } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "appearance/bg.png",
        target: "wallpaper",
        rejected: false,
        focused: true,
        refreshKey: 0,
      }),
    );
    await waitFor(() => expect(result.current.url).not.toBeNull());

    act(() => {
      result.current.reportDecodeFailure();
    });

    expect(result.current.url).toBeNull();
    expect(result.current.status).toBe("unavailable");
    // Persistence is untouched: this failed lease may predate a newer
    // accepted write, so the underlying blob must survive for a later retry.
    const stillPersisted = await cache.readAppearanceBlob(
      SCOPE,
      "appearance/bg.png",
    );
    expect(stillPersisted).not.toBeNull();
  });
});

describe("useAppearanceAsset: rejected replacement artwork never overwrites last-known-good", () => {
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cases: Array<{
    readonly name: string;
    readonly target: AppearanceUpload["target"];
    readonly ordering: "issue-first" | "candidate-first";
    readonly rejectedBytes: () => Uint8Array<ArrayBuffer>;
  }> = [
    {
      name: "wallpaper, host already flags the issue (issue-first)",
      target: "wallpaper",
      ordering: "issue-first",
      rejectedBytes: animatedPng1x1,
    },
    {
      name: "wallpaper, the hook's own validation catches an animated replacement (candidate-first)",
      target: "wallpaper",
      ordering: "candidate-first",
      rejectedBytes: animatedPng1x1,
    },
    {
      name: "icon, host already flags the issue (issue-first)",
      target: "icon",
      ordering: "issue-first",
      rejectedBytes: () => oversizedBytes(MAX_APPEARANCE_ICON_BYTES),
    },
    {
      name: "icon, the hook's own validation catches an oversized replacement (candidate-first)",
      target: "icon",
      ordering: "candidate-first",
      rejectedBytes: () => oversizedBytes(MAX_APPEARANCE_ICON_BYTES),
    },
    {
      name: "icon, animated replacement (issue-first)",
      target: "icon",
      ordering: "issue-first",
      rejectedBytes: animatedPng1x1,
    },
    {
      name: "icon, animated replacement (candidate-first)",
      target: "icon",
      ordering: "candidate-first",
      rejectedBytes: animatedPng1x1,
    },
    {
      name: "wallpaper, oversized replacement (issue-first)",
      target: "wallpaper",
      ordering: "issue-first",
      rejectedBytes: () => oversizedBytes(MAX_APPEARANCE_WALLPAPER_BYTES),
    },
    {
      name: "wallpaper, oversized replacement (candidate-first)",
      target: "wallpaper",
      ordering: "candidate-first",
      rejectedBytes: () => oversizedBytes(MAX_APPEARANCE_WALLPAPER_BYTES),
    },
  ];

  it.each(cases)(
    "valid cached artwork survives a rejected same-path replacement, then going offline - $name",
    async ({ target, ordering, rejectedBytes }) => {
      const { hooks, cache, authStore } = await loadHooks();
      signIn(authStore, "acct-1");
      const path = "appearance/asset.png";
      await cache.writeAppearanceBlob(SCOPE, path, pngBlob(realPng1x1()));

      const { result, rerender, unmount } = renderHook(
        (props: { readonly rejected: boolean }) =>
          hooks.useAppearanceAsset({
            scope: SCOPE,
            path,
            target,
            rejected: props.rejected,
            focused: true,
            refreshKey: 0,
          }),
        { initialProps: { rejected: false } },
      );
      // Let the CACHED blob resolve on its own default-succeeding validation
      // first - only THEN install the barrier/rejecting fetch, or they would
      // also capture/interfere with that unrelated initial call.
      await waitFor(() => expect(result.current.url).not.toBeNull());
      const lastKnownGoodUrl = result.current.url;
      const lastKnownGoodBytes = await readPersistedBytes(cache, SCOPE, path);
      expect(lastKnownGoodBytes).toEqual(realPng1x1());

      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(pngBlob(rejectedBytes()))),
      );
      vi.stubGlobal("fetch", fetchMock);
      const barrier = await installValidationBarrier();

      // Replace the referenced file in place with a rejected candidate.
      hostFileAssetMock.result = liveState({
        status: "ready",
        url: "blob:live-replacement",
        totalBytes: 1,
      });
      rerender({ rejected: ordering === "issue-first" });

      if (ordering === "issue-first") {
        // The host already flagged the field - the hook must never even try
        // to stream or validate a replacement for it.
        expect(hostFileAssetMock.calls.at(-1)?.request).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(barrier.outcomes.length).toBe(0);
      } else {
        // Deterministically wait for THIS candidate's validation to settle -
        // not for some observable side effect that could equally pass before
        // the async fetch/validate chain has even started.
        await waitFor(() => expect(barrier.outcomes.length).toBe(1));
        const outcome = await barrier.outcomes[0];
        expect(outcome.status).toBe("rejected");
      }

      expect(result.current.url).toBe(lastKnownGoodUrl);
      expect(result.current.status).toBe("ready");
      const stillPersisted = await readPersistedBytes(cache, SCOPE, path);
      expect(stillPersisted).toEqual(realPng1x1());

      // Offline: the live source drops back to loading, AND the component
      // remounts fresh (no in-memory `retained` state survives this) - only
      // a genuinely PERSISTED (disk) blob can produce the same URL again.
      hostFileAssetMock.result = liveState({});
      unmount();
      currentImageBlobCache?.clear();
      const { result: remounted } = renderHook(() =>
        hooks.useAppearanceAsset({
          scope: SCOPE,
          path,
          target,
          rejected: false,
          focused: true,
          refreshKey: 0,
        }),
      );
      await waitFor(() => expect(remounted.current.url).not.toBeNull());
      const rereadBytes = await readPersistedBytes(cache, SCOPE, path);
      expect(rereadBytes).toEqual(realPng1x1());
    },
  );

  it.each([{ target: "wallpaper" as const }, { target: "icon" as const }])(
    "a structurally valid PNG that fails real decoding is rejected the same way, retaining last-known-good - $target",
    async ({ target }) => {
      const { hooks, cache, authStore } = await loadHooks();
      signIn(authStore, "acct-1");
      const path = "appearance/asset.png";
      await cache.writeAppearanceBlob(SCOPE, path, pngBlob(realPng1x1()));

      const { result, rerender, unmount } = renderHook(() =>
        hooks.useAppearanceAsset({
          scope: SCOPE,
          path,
          target,
          rejected: false,
          focused: true,
          refreshKey: 0,
        }),
      );
      // Let the CACHED blob resolve first - installing the barrier only
      // AFTER this means outcomes[0] below is unambiguously the live
      // candidate's own validation, not the unrelated initial one.
      await waitFor(() => expect(result.current.url).not.toBeNull());
      const lastKnownGoodUrl = result.current.url;
      const barrier = await installValidationBarrier();

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response(pngBlob(realPng1x1Alt()))),
        ),
      );
      bitmapCodecMock.decodeBitmap.mockRejectedValueOnce(
        new Error("corrupt IDAT"),
      );
      hostFileAssetMock.result = liveState({
        status: "ready",
        url: "blob:live-corrupt",
        totalBytes: 1,
      });
      rerender();

      await waitFor(() => expect(barrier.outcomes.length).toBe(1));
      const outcome = await barrier.outcomes[0];
      expect(outcome.status).toBe("rejected");

      expect(result.current.url).toBe(lastKnownGoodUrl);
      expect(result.current.status).toBe("ready");
      const stillPersisted = await readPersistedBytes(cache, SCOPE, path);
      expect(stillPersisted).toEqual(realPng1x1());

      // Offline + remount: prove the survival is genuinely PERSISTED, not
      // just an in-memory `retained` value this same component held onto.
      hostFileAssetMock.result = liveState({});
      unmount();
      currentImageBlobCache?.clear();
      const { result: remounted } = renderHook(() =>
        hooks.useAppearanceAsset({
          scope: SCOPE,
          path,
          target,
          rejected: false,
          focused: true,
          refreshKey: 0,
        }),
      );
      await waitFor(() => expect(remounted.current.url).not.toBeNull());
      const rereadBytes = await readPersistedBytes(cache, SCOPE, path);
      expect(rereadBytes).toEqual(realPng1x1());
    },
  );

  it.each<{ readonly mechanism: "unmount" | "account-switch" | "issue-param" }>(
    [
      { mechanism: "unmount" },
      { mechanism: "account-switch" },
      { mechanism: "issue-param" },
    ],
  )(
    "a candidate whose decode is still pending when cancelled by $mechanism closes the bitmap and never publishes or persists it",
    async ({ mechanism }) => {
      const { hooks, cache, authStore } = await loadHooks();
      signIn(authStore, "acct-1");
      const path = "appearance/asset.png";
      await cache.writeAppearanceBlob(SCOPE, path, pngBlob(realPng1x1()));

      const { result, rerender, unmount } = renderHook(
        (props: { readonly rejected: boolean }) =>
          hooks.useAppearanceAsset({
            scope: SCOPE,
            path,
            target: "wallpaper",
            rejected: props.rejected,
            focused: true,
            refreshKey: 0,
          }),
        { initialProps: { rejected: false } },
      );
      // Mount with the CACHED blob first, so its own (default-succeeding)
      // decode is what the initial render consumes - only THEN install the
      // pending gate for the live candidate's decode, or it would block the
      // cached blob's own resolution instead.
      await waitFor(() => expect(result.current.url).not.toBeNull());
      const lastKnownGoodUrl = result.current.url;

      const gate = pendingDecode();
      gate.install();
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(pngBlob(realPng1x1Alt()))),
      );
      vi.stubGlobal("fetch", fetchMock);
      hostFileAssetMock.result = liveState({
        status: "ready",
        url: "blob:live-pending",
        totalBytes: 1,
      });
      rerender({ rejected: false });

      // Wait for the candidate's decode to be genuinely IN FLIGHT (not just
      // scheduled) before asserting anything about what's still displayed.
      await gate.entered;
      expect(result.current.url).toBe(lastKnownGoodUrl);

      if (mechanism === "unmount") {
        unmount();
      } else if (mechanism === "account-switch") {
        act(() => signIn(authStore, "acct-2"));
      } else {
        rerender({ rejected: true });
      }

      gate.resolve();
      await waitFor(() => expect(gate.close).toHaveBeenCalledTimes(1));
      if (mechanism === "account-switch") {
        expect(result.current.url).toBeNull();
        unmount();
        act(() => signIn(authStore, "acct-1"));
      }

      const stillPersisted = await readPersistedBytes(cache, SCOPE, path);
      expect(stillPersisted).toEqual(realPng1x1());
    },
  );
});

describe("useAppearanceAsset: offline fallback re-acquires the newest live bytes (fallback-lease regression)", () => {
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function waitForPersisted(
    cache: CacheModule,
    path: string,
    expected: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    await waitFor(async () => {
      const bytes = await readPersistedBytes(cache, SCOPE, path);
      expect(bytes).toEqual(expected);
    });
  }

  it("cached A, live serves B, then offline - the fallback shows B, never the original A lease", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceBlob(SCOPE, "bg.png", pngBlob(realPng1x1()));

    const { result, rerender } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "bg.png",
        target: "wallpaper",
        rejected: false,
        focused: true,
        refreshKey: 0,
      }),
    );
    await waitFor(() => expect(result.current.url).not.toBeNull());
    const urlA = result.current.url;

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(pngBlob(realPng1x1Alt()))),
      ),
    );
    hostFileAssetMock.result = liveState({
      status: "ready",
      url: "blob:live-b",
      totalBytes: 1,
    });
    rerender();

    await waitForPersisted(cache, "bg.png", realPng1x1Alt());
    expect(result.current.url).not.toBe(urlA);
    const urlB = result.current.url;

    // "Offline": the live source drops back to loading.
    hostFileAssetMock.result = liveState({});
    rerender();

    await waitFor(() => expect(result.current.url).toBe(urlB));
  });

  it("cold cache miss, live serves B, then offline - the fallback resolves to B", async () => {
    const { hooks, cache, authStore } = await loadHooks();
    signIn(authStore, "acct-1");
    const readBlobSpy = vi.spyOn(cache, "readAppearanceBlob");

    const { result, rerender } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "bg.png",
        target: "wallpaper",
        rejected: false,
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
      () => expect(readBlobSpy).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS),
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
        Promise.resolve(new Response(pngBlob(realPng1x1Alt()))),
      ),
    );
    hostFileAssetMock.result = liveState({
      status: "ready",
      url: "blob:live-b",
      totalBytes: 1,
    });
    rerender();
    await waitForPersisted(cache, "bg.png", realPng1x1Alt());
    const urlB = result.current.url;
    expect(urlB).not.toBeNull();

    hostFileAssetMock.result = liveState({});
    rerender();

    await waitFor(() => expect(result.current.url).toBe(urlB));
  }, 10_000);

  it("a stale decode-failure callback captured while A was displayed cannot discard B once B is displayed", async () => {
    const { hooks, cache, authStore, imageBlobCache } = await loadHooks();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceBlob(SCOPE, "bg.png", pngBlob(realPng1x1()));

    const { result, rerender } = renderHook(() =>
      hooks.useAppearanceAsset({
        scope: SCOPE,
        path: "bg.png",
        target: "wallpaper",
        rejected: false,
        focused: true,
        refreshKey: 0,
      }),
    );
    await waitFor(() => expect(result.current.url).not.toBeNull());
    const staleReportDecodeFailure = result.current.reportDecodeFailure;

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(pngBlob(realPng1x1Alt()))),
      ),
    );
    hostFileAssetMock.result = liveState({
      status: "ready",
      url: "blob:live-b",
      totalBytes: 1,
    });
    rerender();
    await waitForPersisted(cache, "bg.png", realPng1x1Alt());
    const urlB = result.current.url;

    const removeSpy = vi.spyOn(cache, "removeAppearanceBlob");
    const discardSpy = vi.spyOn(imageBlobCache, "discard");
    act(() => {
      staleReportDecodeFailure();
    });

    expect(removeSpy).not.toHaveBeenCalled();
    expect(discardSpy).not.toHaveBeenCalled();
    expect(result.current.url).toBe(urlB);
    const stillCachedBytes = await readPersistedBytes(cache, SCOPE, "bg.png");
    expect(stillCachedBytes).toEqual(realPng1x1Alt());
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
        issues: [],
        focused: true,
        refreshKey: 0,
      }),
    );

    expect(result.current.wallpaperUrl).toBeNull();
    expect(result.current.wallpaper).toEqual({ kind: "none" });
  });

  it("falls back to the global wallpaper when the project has none set", async () => {
    const { hooks, cache, authStore, settingsStore } = await loadHooks();
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
    await cache.writeAppearanceBlob(null, "global.png", pngBlob(realPng1x1()));
    const persistedBytes = await readPersistedBytes(cache, null, "global.png");
    expect(persistedBytes).toEqual(realPng1x1());

    const { result } = renderHook(() =>
      hooks.useResolvedAppearanceAssets({
        scope: SCOPE,
        appearance: null,
        issues: [],
        focused: true,
        refreshKey: 0,
      }),
    );

    await waitFor(() => expect(result.current.wallpaperUrl).not.toBeNull());
    expect(result.current.wallpaper).toEqual(globalWallpaper);
  });

  it("routes a host-flagged wallpaper issue straight to the wallpaper asset as rejected, never asking the live host", async () => {
    const { hooks, authStore } = await loadHooks();
    signIn(authStore, "acct-1");

    renderHook(() =>
      hooks.useResolvedAppearanceAssets({
        scope: SCOPE,
        appearance: {
          version: 1,
          wallpaper: {
            kind: "image",
            path: "bg.png",
            focalPoint: [0.5, 0.5],
            treatment: "original",
            dimming: 0,
            strength: 1,
          },
        },
        issues: ["wallpaper"],
        focused: true,
        refreshKey: 0,
      }),
    );

    const projectCall = hostFileAssetMock.calls.find(
      (call) => call.request !== null,
    );
    expect(projectCall).toBeUndefined();
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
        blob: pngBlob(realPng1x1()),
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
