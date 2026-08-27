import type {
  BrowserViewBounds,
  BrowserViewViewportPresetId,
} from "../../../ipc-contracts/browser-view-types";
import { log } from "../../app/logger";
import { createBoundsStreamStats } from "./bounds-stream-stats";
import type { BrowserViewEntry } from "./browser-view-entry";
import { browserViewSurfaceKey as entryKeyId } from "./browser-view-entry-registry";
import type { BrowserViewWindow } from "../browser-view-port";
import {
  TileFrameCache,
  defaultTileFrameEncoder,
  TILE_FRAME_JPEG_QUALITY,
  TILE_FRAME_MAX_ATTACHED,
  TILE_FRAME_MAX_DIMENSION,
  TILE_FRAME_MIN_INTERVAL_MS,
  TILE_FRAME_STALE_AFTER_MS,
  type EncodedTileFrame,
} from "./tile-frame-cache";

const encodeCapturedTileFrame = defaultTileFrameEncoder(
  TILE_FRAME_JPEG_QUALITY,
  TILE_FRAME_MAX_DIMENSION,
);

const VIEWPORT_PRESETS: Readonly<
  Record<
    BrowserViewViewportPresetId,
    { readonly width: number | null; readonly height: number | null }
  >
> = {
  responsive: { width: null, height: null },
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};

interface BrowserViewGeometryOptions {
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  /** Flush window for the aggregate `bounds_stream` perf log. */
  readonly boundsStreamLogIntervalMs: number;
}

/**
 * Owns everything that decides where a native tile sits and whether it is
 * composited: effective bounds, the visibility predicate, and the BT-202
 * rolling frame feed that follows visibility.
 */
export class BrowserViewGeometry {
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly boundsStreamLogIntervalMs: number;
  private readonly boundsStreamStats = createBoundsStreamStats();
  private boundsStreamLogTimer: NodeJS.Timeout | null = null;
  private lastFrameCacheStatsSignature: string | null = null;
  /**
   * BT-202: per-tile rolling frame cache feeding overlay occlusion. Slots are
   * keyed by `entryKeyId`; attached while a tile is bound to a live window.
   */
  private readonly tileFrames = new TileFrameCache({
    minIntervalMs: TILE_FRAME_MIN_INTERVAL_MS,
    staleAfterMs: TILE_FRAME_STALE_AFTER_MS,
    maxDimension: TILE_FRAME_MAX_DIMENSION,
    jpegQuality: TILE_FRAME_JPEG_QUALITY,
    maxAttached: TILE_FRAME_MAX_ATTACHED,
    onEvict: (key) => {
      log.warn("[browser-view] frame cache slot evicted (cap)", { keyId: key });
    },
    now: () => Date.now(),
    encode: encodeCapturedTileFrame,
  });

  constructor(options: BrowserViewGeometryOptions) {
    this.getWindow = options.getWindow;
    this.boundsStreamLogIntervalMs = options.boundsStreamLogIntervalMs;
  }

  cachedFrame(keyId: string): EncodedTileFrame | null {
    return this.tileFrames.get(keyId);
  }

  isFrameFresh(keyId: string): boolean {
    return this.tileFrames.isFresh(keyId);
  }

  detachFrames(keyId: string): void {
    this.tileFrames.detach(keyId);
  }

  dispose(): void {
    if (this.boundsStreamLogTimer !== null) {
      clearTimeout(this.boundsStreamLogTimer);
      this.boundsStreamLogTimer = null;
    }
    this.tileFrames.detachAll();
  }

  applyBounds(entry: BrowserViewEntry): void {
    // Parked under an overlay (BT-202): record nothing here — the renderer
    // may keep streaming rects while a menu is open, and applying them would
    // yank the offscreen-parked view back over the popover. The stored
    // rect is applied by the release path.
    if (entry.overlayOwnerIds.length > 0) return;
    if (entry.bounds === null) return;
    const bounds = effectiveViewportBounds(entry.bounds, entry.viewportPreset);
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.boundsStreamStats.recordRejected();
      this.armBoundsStreamLogFlush();
      return;
    }
    if (
      entry.lastAppliedBounds !== null &&
      boundsAreIdentical(bounds, entry.lastAppliedBounds)
    ) {
      this.boundsStreamStats.recordCoalesced();
      this.armBoundsStreamLogFlush();
      return;
    }
    const maxDeltaPx =
      entry.lastAppliedBounds === null
        ? null
        : boundsMaxComponentDelta(entry.lastAppliedBounds, bounds);
    entry.view.setBounds(bounds);
    entry.lastAppliedBounds = bounds;
    this.boundsStreamStats.recordApplied(maxDeltaPx);
    this.armBoundsStreamLogFlush();
  }

  applyVisibility(entry: BrowserViewEntry): void {
    const surface = entry.surface;
    if (surface === null) {
      entry.visible = false;
      entry.lastLoggedVisible = false;
      entry.view.setVisible(false);
      return;
    }
    const window = this.getWindow(surface.windowId);
    const hasUsableBounds =
      entry.bounds !== null &&
      entry.bounds.width > 0 &&
      entry.bounds.height > 0;
    const visible =
      entry.desiredVisible &&
      entry.overlayOwnerIds.length === 0 &&
      !entry.rendererResetPending &&
      hasUsableBounds &&
      entry.status !== "dead" &&
      window !== null &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized();
    entry.visible = visible;
    // A tile parked under an active overlay (BT-202) keeps its
    // offscreen-visible posture so its compositor keeps feeding the frame
    // cache; visibility is recomputed when the last owner releases. A dead
    // tile must never stay parked-visible, so it falls through instead.
    if (entry.overlayParked && entry.status !== "dead") return;
    if (entry.lastLoggedVisible !== visible) {
      log.info("[browser-view] visibility changed", {
        keyId: entryKeyId(surface),
        visible,
        desiredVisible: entry.desiredVisible,
        overlayOwnerCount: entry.overlayOwnerIds.length,
        rendererResetPending: entry.rendererResetPending,
        hasUsableBounds,
        status: entry.status,
        windowVisible:
          window !== null && !window.isDestroyed() && window.isVisible(),
        windowMinimized:
          window !== null && !window.isDestroyed() && window.isMinimized(),
      });
      entry.lastLoggedVisible = visible;
    }
    entry.view.setVisible(visible);
    this.syncTileFrameFeed(entry, window);
  }

  /**
   * BT-202: keep a frame-cache slot subscribed exactly while the tile's
   * guest can plausibly produce compositor frames - bound to a live window,
   * wanted visible, usable geometry, not dead. Hidden or detached tiles drop
   * their subscription; re-attaching is cheap.
   */
  private syncTileFrameFeed(
    entry: BrowserViewEntry,
    window: BrowserViewWindow | null,
  ): void {
    const surface = entry.surface;
    if (surface === null) return;
    const keyId = entryKeyId(surface);
    const feedLive =
      entry.desiredVisible &&
      !entry.rendererResetPending &&
      entry.bounds !== null &&
      entry.bounds.width > 0 &&
      entry.bounds.height > 0 &&
      entry.status !== "dead" &&
      !entry.view.webContents.isDestroyed() &&
      window !== null &&
      !window.isDestroyed();
    if (!feedLive) {
      this.tileFrames.detach(keyId);
      return;
    }
    this.tileFrames.attach(keyId, {
      beginFrameSubscription: (callback) => {
        entry.view.webContents.beginFrameSubscription((image) => {
          callback(image);
        });
      },
      endFrameSubscription: () => {
        entry.view.webContents.endFrameSubscription();
      },
    });
  }

  /**
   * BT-101: emit one aggregate `bounds_stream` line per interval window while
   * bounds updates are flowing. The renderer streams rects every animation
   * frame during a resize drag; this keeps the perf lane readable while still
   * exposing call rate, coalesce ratio, and the largest geometry jump.
   */
  private armBoundsStreamLogFlush(): void {
    const flush = (): void => {
      this.boundsStreamLogTimer = null;
      const payload = this.boundsStreamStats.drain(
        this.boundsStreamLogIntervalMs,
      );
      if (payload === null) return;
      log.info("[browser-view] bounds stream", {
        kind: "bounds_stream",
        ...payload,
      });
      this.logFrameCacheStats();
    };
    if (this.boundsStreamLogTimer !== null) return;
    if (!(this.boundsStreamLogIntervalMs > 0)) {
      flush();
      return;
    }
    this.boundsStreamLogTimer = setTimeout(
      flush,
      this.boundsStreamLogIntervalMs,
    );
  }

  /** BT-205: frame-cache counters on the perf lane, deduped while idle. */
  private logFrameCacheStats(): void {
    const stats = this.tileFrames.stats();
    const signature = JSON.stringify(stats);
    if (signature === this.lastFrameCacheStatsSignature) return;
    this.lastFrameCacheStatsSignature = signature;
    log.info("[browser-view] frame cache stats", {
      kind: "frame_cache_stats",
      ...stats,
    });
  }
}

export function normalizeBounds(bounds: BrowserViewBounds): BrowserViewBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

export function effectiveViewportBounds(
  container: BrowserViewBounds,
  presetId: BrowserViewViewportPresetId,
): BrowserViewBounds {
  const preset = VIEWPORT_PRESETS[presetId];
  if (preset.width === null || preset.height === null) return container;
  const width = Math.min(container.width, preset.width);
  const height = Math.min(container.height, preset.height);
  return {
    x: container.x + Math.floor((container.width - width) / 2),
    y: container.y + Math.floor((container.height - height) / 2),
    width,
    height,
  };
}

function boundsAreIdentical(
  left: BrowserViewBounds,
  right: BrowserViewBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function boundsMaxComponentDelta(
  left: BrowserViewBounds,
  right: BrowserViewBounds,
): number {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}
