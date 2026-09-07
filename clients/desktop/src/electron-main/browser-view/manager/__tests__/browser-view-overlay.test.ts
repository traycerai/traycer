import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerHostEvent } from "../../../../ipc-contracts/ipc-channels";
import type { BrowserSessionProfile } from "../../browser-session";
import type {
  BrowserViewCapturedImage,
  BrowserViewCropRect,
  BrowserViewFrameImage,
  BrowserViewWindow,
  ManagedBrowserView,
} from "../../browser-view-port";
import { BrowserViewGeometry } from "../browser-view-geometry";
import { BrowserViewEntryRegistry } from "../browser-view-entry-registry";
import type { BrowserViewEntry, BrowserViewSend } from "../browser-view-entry";
import {
  BrowserViewOverlay,
  CAPTURE_STANDIN_DEADLINE_MS,
  RESTORE_FRAME_BUDGET_MS,
} from "../browser-view-overlay";
import { NativeBrowserViewLifecycle } from "../native-browser-view-lifecycle";
import { browserViewSurfaceKey as entryKeyId } from "../browser-view-entry-registry";
import type { EncodedTileFrame } from "../tile-frame-cache";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const WINDOW_ID = "window-1";
const TILE = {
  viewTabId: "tab-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "session-1",
};

/** Deterministic stand-in for the real frame feed: no attach/detach wiring,
 * just the two accessors `occludeEntry` actually reads. */
class FakeGeometry extends BrowserViewGeometry {
  frame: EncodedTileFrame | null = null;
  fresh = false;

  constructor() {
    super({
      getWindow: () => null,
      getZoomFactor: () => 1,
      boundsStreamLogIntervalMs: 0,
    });
  }

  override cachedFrame(): EncodedTileFrame | null {
    return this.frame;
  }

  override isFrameFresh(): boolean {
    return this.fresh;
  }
}

/** Encodes `payload` as bytes the production code base64s into a
 * `data:image/jpeg;...` URL - what `capturePage().toJPEG()` yields, minus
 * real JPEG bytes. `jpegDataUrl` below computes the matching expectation. */
class FakeCapturedImage implements BrowserViewCapturedImage {
  constructor(private readonly payload: string) {}

  getSize(): { readonly width: number; readonly height: number } {
    return { width: 100, height: 100 };
  }

  toJPEG(): Uint8Array {
    return new Uint8Array(Buffer.from(this.payload));
  }

  toDataURL(): string {
    return this.payload;
  }

  isEmpty(): boolean {
    return false;
  }

  crop(_rect: BrowserViewCropRect): BrowserViewCapturedImage {
    return this;
  }

  toPNG(): Uint8Array {
    return new Uint8Array();
  }
}

function jpegDataUrl(payload: string): string {
  return `data:image/jpeg;base64,${Buffer.from(payload).toString("base64")}`;
}

interface DeferredCapture {
  readonly resolve: (payload: string) => void;
  readonly reject: (error: unknown) => void;
}

function deferredCapture(): {
  readonly capturePage: () => Promise<BrowserViewCapturedImage>;
  readonly deferred: DeferredCapture;
} {
  const { promise, resolve, reject } =
    Promise.withResolvers<BrowserViewCapturedImage>();
  return {
    capturePage: () => promise,
    deferred: {
      resolve: (payload) => resolve(new FakeCapturedImage(payload)),
      reject,
    },
  };
}

function makeEntry(
  capturePage: () => Promise<BrowserViewCapturedImage>,
): BrowserViewEntry {
  const view: ManagedBrowserView = {
    webContents: {
      id: 1,
      session: { cookies: { set: vi.fn(), get: vi.fn(), flushStore: vi.fn() } },
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
      navigationHistory: undefined,
      loadURL: vi.fn(),
      executeJavaScript: vi.fn(),
      capturePage,
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isDestroyed: () => false,
      close: vi.fn(),
      reload: vi.fn(),
      findInPage: () => 0,
      stopFindInPage: vi.fn(),
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setDevToolsWebContents: vi.fn(),
      openDevTools: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      beginFrameSubscription: vi.fn(),
      endFrameSubscription: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  };

  return {
    surface: { ...TILE, windowId: WINDOW_ID },
    surfaceBindingId: null,
    guestKey: "guest-1",
    identity: {
      key: { hostId: "host-1", sessionId: "sess-1", tabId: "tab-1" },
      registrationId: "reg-1",
      lifecycleWindowId: WINDOW_ID,
      lifecycle: new NativeBrowserViewLifecycle(),
    },
    profile: "primary" satisfies BrowserSessionProfile,
    view,
    listeners: {},
    parentWindowId: WINDOW_ID,
    desiredVisible: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    lastAppliedBounds: null,
    requestedUrl: "https://example.com",
    currentUrl: "https://example.com",
    currentTitle: "Example",
    status: "ready",
    statusReason: null,
    findState: {
      appRequestId: 0,
      query: "",
      matchCase: false,
      sessionsByElectronRequestId: new Map(),
    },
    certificateError: null,
    debugSession: null,
    annotationSession: null,
    devToolsWindow: null,
    viewportPreset: "responsive",
    overlayOwnerIds: [],
    overlaySnapshotStale: false,
    overlayAwaitingPaintAck: false,
    overlayParked: false,
    overlayRestoreToken: null,
    visible: true,
    lastLoggedVisible: true,
    rendererResetPending: false,
    internalNavigation: false,
    closePromise: null,
  };
}

describe("BrowserViewOverlay swap-source (invariant 6)", () => {
  let geometry: FakeGeometry;
  let overlay: BrowserViewOverlay;
  let registry: BrowserViewEntryRegistry<BrowserViewEntry>;

  beforeEach(() => {
    vi.useFakeTimers();
    geometry = new FakeGeometry();
    registry = new BrowserViewEntryRegistry<BrowserViewEntry>();
    overlay = new BrowserViewOverlay({
      entries: registry,
      geometry,
      send: () => true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a fast capture wins over the cache", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    geometry.frame = { dataUrl: "data:cached", width: 10, height: 10 };
    geometry.fresh = true;

    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    deferred.resolve("captured");
    const result = await occludePromise;

    expect(result.snapshots).toEqual([
      { ...TILE, dataUrl: jpegDataUrl("captured"), stale: false },
    ]);
    expect(entry.overlayAwaitingPaintAck).toBe(true);
  });

  it("a slow capture loses to the warm cache at the deadline", async () => {
    const { capturePage } = deferredCapture(); // never resolves within the test
    const entry = makeEntry(capturePage);
    registry.register(entry);
    geometry.frame = { dataUrl: "data:cached", width: 10, height: 10 };
    geometry.fresh = false;

    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    await vi.advanceTimersByTimeAsync(CAPTURE_STANDIN_DEADLINE_MS);
    const result = await occludePromise;

    expect(result.snapshots).toEqual([
      { ...TILE, dataUrl: "data:cached", stale: true },
    ]);
  });

  it("discards a capture that resolves after the deadline", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    geometry.frame = { dataUrl: "data:cached", width: 10, height: 10 };
    geometry.fresh = true;

    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    await vi.advanceTimersByTimeAsync(CAPTURE_STANDIN_DEADLINE_MS);
    const result = await occludePromise;
    expect(result.snapshots).toEqual([
      { ...TILE, dataUrl: "data:cached", stale: false },
    ]);

    // The late capture settling afterwards must not retroactively change
    // anything: the snapshot already returned is the final word.
    deferred.resolve("too-late");
    await vi.runAllTimersAsync();
    expect(result.snapshots).toEqual([
      { ...TILE, dataUrl: "data:cached", stale: false },
    ]);
  });

  it("falls back to the warm cache when capture fails", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    geometry.frame = { dataUrl: "data:cached", width: 10, height: 10 };
    geometry.fresh = true;

    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    deferred.reject(new Error("capture failed"));
    const result = await occludePromise;

    expect(result.snapshots).toEqual([
      { ...TILE, dataUrl: "data:cached", stale: false },
    ]);
  });

  it("yields dataUrl: null on a failed capture with a cold cache, still awaiting paint-ack", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    geometry.frame = null;

    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    deferred.reject(new Error("capture failed"));
    const result = await occludePromise;

    expect(result.snapshots).toEqual([
      { ...TILE, dataUrl: null, stale: false },
    ]);
    expect(entry.overlayAwaitingPaintAck).toBe(true);
  });
});

/** Satisfies `BrowserViewWindow` minimally so `applyVisibility`'s liveness
 * check reports `windowAlive`/`windowOnScreen: true` and `syncTileFrameFeed`
 * actually attaches a frame subscription - the real BT-201 mechanism the
 * exit-edge handshake reads its "first composited frame" signal from. */
function makeWindow(): BrowserViewWindow {
  return {
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
    webContents: null,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
  };
}

/** A non-empty composited frame, structurally: `handleFrame` resolves any
 * pending `awaitNextFrame` wait before it ever touches `resize`/`toJPEG`, so
 * this stands in for a real `NativeImage` without needing real JPEG bytes.
 * Typed as the WIDER `BrowserViewFrameImage` the frame subscription hands out
 * (a `NativeImage` in production); the frame cache only ever reads the
 * narrower `TileFrameImage` subset of it. */
const FRAME_IMAGE: BrowserViewFrameImage = {
  isEmpty: () => false,
  getSize: () => ({ width: 10, height: 10 }),
  toJPEG: () => new Uint8Array(),
  toPNG: () => new Uint8Array(),
  toDataURL: () => "data:image/png;base64,",
  crop: () => FRAME_IMAGE,
  resize: () => FRAME_IMAGE,
};

describe("BrowserViewOverlay restore handshake (invariant 4)", () => {
  let geometry: BrowserViewGeometry;
  let registry: BrowserViewEntryRegistry<BrowserViewEntry>;
  let overlay: BrowserViewOverlay;
  let sendCalls: Array<Parameters<BrowserViewSend>>;

  beforeEach(() => {
    vi.useFakeTimers();
    sendCalls = [];
    geometry = new BrowserViewGeometry({
      getWindow: (windowId) => (windowId === WINDOW_ID ? makeWindow() : null),
      getZoomFactor: () => 1,
      boundsStreamLogIntervalMs: 0,
    });
    registry = new BrowserViewEntryRegistry<BrowserViewEntry>();
    overlay = new BrowserViewOverlay({
      entries: registry,
      geometry,
      send: (windowId, channel, payload) => {
        sendCalls.push([windowId, channel, payload]);
        return true;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Occludes and parks one entry the way the real flow does: a fast
   * capture, then the renderer's paint ack. */
  async function occludeAndPark(entry: BrowserViewEntry): Promise<void> {
    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    await occludePromise;
    overlay.paintAck("overlay-1");
    expect(entry.overlayParked).toBe(true);
  }

  it("un-parks synchronously but only notifies the renderer once the restored view's first frame composites", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const occludePromise = occludeAndPark(entry);
    deferred.resolve("captured");
    await occludePromise;

    const setBoundsCallsBefore = vi.mocked(entry.view.setBounds).mock.calls
      .length;

    const result = overlay.release({ overlayId: "overlay-1" });

    // Step one already ran, synchronously, inside `release`: the view is
    // un-parked (bounds/visibility restored) and the stand-in is still
    // registered - the ordering invariant 4 requires directly, not just
    // observed at the endpoints.
    expect(entry.overlayParked).toBe(false);
    expect(vi.mocked(entry.view.setBounds).mock.calls.length).toBeGreaterThan(
      setBoundsCallsBefore,
    );
    expect(vi.mocked(entry.view.setVisible)).toHaveBeenCalledWith(true);
    // Step two has not happened yet: the tile was parked, so it cannot
    // answer through the synchronous return value, and no restored event
    // has fired either.
    expect(result.restoredTiles).toEqual([]);
    expect(sendCalls).toEqual([]);

    // Drive the exact subscription BT-201's `TileFrameCache` attached during
    // step one - no second frame source.
    const onFrame = vi
      .mocked(entry.view.webContents.beginFrameSubscription)
      .mock.calls.at(-1)?.[0];
    if (onFrame === undefined)
      throw new Error("no frame subscription attached");
    onFrame(FRAME_IMAGE);
    await vi.runAllTimersAsync();

    expect(sendCalls).toEqual([
      [WINDOW_ID, RunnerHostEvent.browserViewOverlayRestored, TILE],
    ]);
  });

  it("still releases through the budget escape when the view produces no frame", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const occludePromise = occludeAndPark(entry);
    deferred.resolve("captured");
    await occludePromise;

    overlay.release({ overlayId: "overlay-1" });
    expect(sendCalls).toEqual([]);

    // No frame ever arrives; only the liveness escape can unblock this.
    await vi.advanceTimersByTimeAsync(RESTORE_FRAME_BUDGET_MS);

    expect(sendCalls).toEqual([
      [WINDOW_ID, RunnerHostEvent.browserViewOverlayRestored, TILE],
    ]);
  });

  it("releases nothing while a nested overlay still holds the tile", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const firstOcclude = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    deferred.resolve("captured");
    await firstOcclude;
    overlay.paintAck("overlay-1");

    // A second overlay occludes the same, already-parked tile - the
    // already-parked fast path in `occludeEntry`, no new capture needed.
    const secondOcclude = await overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-2",
      tiles: [TILE],
    });
    expect(secondOcclude.matchedCount).toBe(1);
    expect(entry.overlayParked).toBe(true);

    const result = overlay.release({ overlayId: "overlay-1" });

    expect(result.restoredTiles).toEqual([]);
    expect(entry.overlayParked).toBe(true);
    expect(entry.overlayOwnerIds).toEqual(["overlay-2"]);
    await vi.advanceTimersByTimeAsync(RESTORE_FRAME_BUDGET_MS);
    expect(sendCalls).toEqual([]);
  });

  it("replays bounds streamed during the restore wait, before the restored event", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const occludePromise = occludeAndPark(entry);
    deferred.resolve("captured");
    await occludePromise;

    overlay.release({ overlayId: "overlay-1" });
    expect(sendCalls).toEqual([]);

    // A rect streams in mid-window; `applyBounds`'s restore-token guard must
    // swallow it (no new `setBounds` call yet).
    const setBoundsCallsBeforeStream = vi.mocked(entry.view.setBounds).mock
      .calls.length;
    entry.bounds = { x: 0, y: 0, width: 400, height: 300 };
    geometry.applyBounds(entry);
    expect(vi.mocked(entry.view.setBounds).mock.calls.length).toBe(
      setBoundsCallsBeforeStream,
    );

    const onFrame = vi
      .mocked(entry.view.webContents.beginFrameSubscription)
      .mock.calls.at(-1)?.[0];
    if (onFrame === undefined)
      throw new Error("no frame subscription attached");
    onFrame(FRAME_IMAGE);
    await vi.runAllTimersAsync();

    // The swallowed rect is replayed BEFORE the restored event is sent.
    const lastSetBounds = vi
      .mocked(entry.view.setBounds)
      .mock.calls.at(-1)?.[0];
    expect(lastSetBounds).toMatchObject({ width: 400, height: 300 });
    expect(sendCalls).toEqual([
      [WINDOW_ID, RunnerHostEvent.browserViewOverlayRestored, TILE],
    ]);
  });

  it("re-occluding a tile cancels its pending restore wait", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const occludePromise = occludeAndPark(entry);
    deferred.resolve("captured");
    await occludePromise;

    overlay.release({ overlayId: "overlay-1" });
    expect(sendCalls).toEqual([]);
    expect(entry.overlayRestoreToken).not.toBeNull();

    const { capturePage: capturePage2, deferred: deferred2 } =
      deferredCapture();
    entry.view.webContents.capturePage = capturePage2;
    const reoccludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-2",
      tiles: [TILE],
    });
    deferred2.resolve("captured-2");
    await reoccludePromise;
    expect(entry.overlayRestoreToken).toBeNull();

    // The stale wait's own resolution (its frame subscription firing) must
    // not fire the restored event for the wait re-occlusion superseded.
    const onFrame = vi
      .mocked(entry.view.webContents.beginFrameSubscription)
      .mock.calls.at(-1)?.[0];
    if (onFrame === undefined)
      throw new Error("no frame subscription attached");
    onFrame(FRAME_IMAGE);
    await vi.runAllTimersAsync();
    expect(sendCalls).toEqual([]);
  });

  it("forgetEntry sends the restored event exactly once when a surface detaches mid-window", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const occludePromise = occludeAndPark(entry);
    deferred.resolve("captured");
    await occludePromise;

    overlay.release({ overlayId: "overlay-1" });
    expect(sendCalls).toEqual([]);
    expect(entry.overlayRestoreToken).not.toBeNull();

    const surface = entry.surface;
    if (surface === null) throw new Error("entry has no surface");
    overlay.forgetEntry(entry, entryKeyId(surface));

    expect(sendCalls).toEqual([
      [WINDOW_ID, RunnerHostEvent.browserViewOverlayRestored, TILE],
    ]);
    expect(entry.overlayRestoreToken).toBeNull();

    // The cancelled wait's own resolution must not send a second time.
    const onFrame = vi
      .mocked(entry.view.webContents.beginFrameSubscription)
      .mock.calls.at(-1)?.[0];
    if (onFrame !== undefined) {
      onFrame(FRAME_IMAGE);
      await vi.runAllTimersAsync();
    }
    expect(sendCalls).toEqual([
      [WINDOW_ID, RunnerHostEvent.browserViewOverlayRestored, TILE],
    ]);
  });

  it("restores synchronously through the return value when the tile never parked", async () => {
    const { capturePage, deferred } = deferredCapture();
    const entry = makeEntry(capturePage);
    registry.register(entry);
    const occludePromise = overlay.occlude(WINDOW_ID, {
      overlayId: "overlay-1",
      tiles: [TILE],
    });
    deferred.resolve("captured");
    await occludePromise;
    // No `paintAck`: the tile is occluded but still awaiting it, so it never
    // left the screen.
    expect(entry.overlayParked).toBe(false);
    expect(entry.overlayAwaitingPaintAck).toBe(true);

    const result = overlay.release({ overlayId: "overlay-1" });

    expect(result.restoredTiles).toEqual([TILE]);
    await vi.advanceTimersByTimeAsync(RESTORE_FRAME_BUDGET_MS);
    expect(sendCalls).toEqual([]);
  });
});
