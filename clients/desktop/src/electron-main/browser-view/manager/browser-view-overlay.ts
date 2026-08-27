import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type {
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewOverlaySnapshot,
  BrowserViewTileKey,
} from "../../../ipc-contracts/browser-view-types";
import { describeLogError, log } from "../../app/logger";
import {
  requireSurface,
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./browser-view-entry";
import {
  browserViewSurfaceKey as entryKeyId,
  type BrowserViewEntryRegistry,
} from "./browser-view-entry-registry";
import {
  effectiveViewportBounds,
  type BrowserViewGeometry,
} from "./browser-view-geometry";

interface BrowserViewOverlayOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly geometry: BrowserViewGeometry;
  readonly send: BrowserViewSend;
}

/**
 * BT-202 overlay occlusion: hands the renderer a frozen frame for every tile
 * an overlay covers, then parks the native view offscreen once that frame is
 * on screen. Ownership is refcounted per overlay id so nested overlays
 * (command palette over a dialog) release in the right order.
 */
export class BrowserViewOverlay {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly geometry: BrowserViewGeometry;
  private readonly send: BrowserViewSend;
  private readonly entryKeysByOwnerId = new Map<string, readonly string[]>();

  constructor(options: BrowserViewOverlayOptions) {
    this.entries = options.entries;
    this.geometry = options.geometry;
    this.send = options.send;
  }

  async occlude(
    windowId: string,
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    const previousKeyIds = this.entryKeysByOwnerId.get(input.overlayId) ?? [];
    const nextKeyIds = input.tiles.map((tile) =>
      entryKeyId({ ...tile, windowId }),
    );
    const nextKeyIdSet = new Set(nextKeyIds);
    const released = previousKeyIds.filter((keyId) => !nextKeyIdSet.has(keyId));
    const restoredTiles = this.releaseEntries(input.overlayId, released);
    this.entryKeysByOwnerId.set(input.overlayId, nextKeyIds);

    const snapshots = await Promise.all(
      nextKeyIds.map((keyId) => this.occludeEntry(input.overlayId, keyId)),
    );

    // An overlay scan can race tile teardown. Log the all-missing case once
    // per scan rather than once per tile.
    const matchedCount = nextKeyIds.filter((keyId) =>
      this.entries.hasSurfaceKey(keyId),
    ).length;
    if (nextKeyIds.length > 0 && matchedCount === 0) {
      log.info("[browser-view] occlude for overlay: no matching entries", {
        overlayId: input.overlayId,
        requestedCount: nextKeyIds.length,
        matchedCount,
      });
    }

    return {
      snapshots: snapshots.filter(
        (snapshot): snapshot is BrowserViewOverlaySnapshot => snapshot !== null,
      ),
      restoredTiles,
    };
  }

  release(input: BrowserViewOverlayRelease): BrowserViewOverlayReleaseResult {
    const keyIds = this.entryKeysByOwnerId.get(input.overlayId) ?? [];
    this.entryKeysByOwnerId.delete(input.overlayId);
    return { restoredTiles: this.releaseEntries(input.overlayId, keyIds) };
  }

  /** Parks occluded native views only after their replacement frames paint. */
  paintAck(overlayId: string): void {
    const keyIds = this.entryKeysByOwnerId.get(overlayId) ?? [];
    for (const keyId of keyIds) {
      const entry = this.entries.getSurfaceByKey(keyId);
      if (entry === undefined) continue;
      if (!entry.overlayOwnerIds.includes(overlayId)) continue;
      if (!entry.overlayAwaitingPaintAck) continue;
      entry.overlayAwaitingPaintAck = false;
      this.parkEntry(entry);
    }
  }

  invalidateSnapshot(entry: BrowserViewEntry, reason: string): void {
    if (entry.overlayOwnerIds.length === 0) return;
    // BT-202 fix (⌘K white-out): an overlay-parked view stays COMPOSITED on
    // purpose — that is what keeps its frame cache converging toward fresh
    // pixels — so per-frame paint churn under an open overlay must not flip
    // the displayed snapshot to stale. The renderer hides the frozen frame
    // entirely once stale, leaving only bg-background: exactly the blank
    // tile users saw behind the command palette. Content-level changes
    // (navigation, title, crash, load lifecycle) still invalidate.
    if (reason === "paint") return;
    if (!entry.overlaySnapshotStale) {
      entry.overlaySnapshotStale = true;
    }
    if (entry.surface === null) return;
    this.send(
      entry.surface.windowId,
      RunnerHostEvent.browserViewSnapshotInvalidated,
      { ...toTileKey(entry.surface), reason },
    );
  }

  /** Drops a detaching surface from every overlay it is still listed under. */
  forgetEntry(entry: BrowserViewEntry, keyId: string): void {
    for (const overlayId of entry.overlayOwnerIds) {
      const keys = this.entryKeysByOwnerId.get(overlayId) ?? [];
      this.entryKeysByOwnerId.set(
        overlayId,
        keys.filter((candidate) => candidate !== keyId),
      );
    }
    entry.overlayOwnerIds = [];
    entry.overlayAwaitingPaintAck = false;
    entry.overlayParked = false;
  }

  /** Follows a surface rebind so an open overlay keeps owning the same tile. */
  rekeyEntry(
    entry: BrowserViewEntry,
    previousKeyId: string | null,
    nextKeyId: string,
  ): void {
    for (const overlayId of entry.overlayOwnerIds) {
      const overlayKeyIds = this.entryKeysByOwnerId.get(overlayId);
      if (overlayKeyIds === undefined) continue;
      this.entryKeysByOwnerId.set(
        overlayId,
        overlayKeyIds.map((keyId) =>
          previousKeyId !== null && keyId === previousKeyId ? nextKeyId : keyId,
        ),
      );
    }
  }

  dispose(): void {
    this.entryKeysByOwnerId.clear();
  }

  private async occludeEntry(
    overlayId: string,
    keyId: string,
  ): Promise<BrowserViewOverlaySnapshot | null> {
    const entry = this.entries.getSurfaceByKey(keyId);
    if (entry === undefined) return null;
    if (entry.overlayOwnerIds.includes(overlayId)) return null;

    if (entry.overlayOwnerIds.length > 0) {
      // Already parked for another overlay; the view stays offscreen-visible
      // and no new pixels are needed.
      entry.overlayOwnerIds.push(overlayId);
      return null;
    }

    // BT-202: paint from the rolling frame cache when it has a slot. This is
    // the instant path (no capture round-trip); `stale` reports whether the
    // cached frame is older than the freshness window. Only a cold cache
    // (first-ever occlusion for this tile, or the feed never ran) pays for
    // capturePage.
    const cached = this.geometry.cachedFrame(keyId);
    let dataUrl: string | null = cached?.dataUrl ?? null;
    let stale = false;
    if (cached !== null) {
      stale = !this.geometry.isFrameFresh(keyId);
    } else {
      try {
        dataUrl = (await entry.view.webContents.capturePage()).toDataURL();
      } catch (err) {
        log.warn("[browser-view] overlay snapshot capture failed", {
          error: describeLogError(err),
          webContentsId: entry.view.webContents.id,
        });
      }
    }

    const activeKeyIds = this.entryKeysByOwnerId.get(overlayId) ?? [];
    if (!activeKeyIds.includes(keyId)) return null;
    const currentEntry = this.entries.getSurfaceByKey(keyId);
    if (currentEntry === undefined) return null;

    currentEntry.overlayOwnerIds.push(overlayId);
    currentEntry.overlaySnapshotStale = false;
    // BT-202 flicker fix: DO NOT park here. The native view must stay on
    // screen until the renderer has DECODED and PAINTED the replacement
    // frame — otherwise there is a guaranteed multi-frame window where the
    // page pixels are gone but nothing covers the tile yet (the reported
    // empty-state flash). The renderer acknowledges via `paintAckOverlay`
    // once img.decode() settles; only then do we move the view offscreen.
    currentEntry.overlayAwaitingPaintAck = true;
    return {
      ...toTileKey(requireSurface(currentEntry)),
      dataUrl,
      stale,
    };
  }

  private parkEntry(entry: BrowserViewEntry): void {
    if (
      entry.bounds === null ||
      entry.bounds.width <= 0 ||
      entry.bounds.height <= 0
    ) {
      entry.view.setVisible(false);
      return;
    }
    const effective = effectiveViewportBounds(
      entry.bounds,
      entry.viewportPreset,
    );
    if (effective.width <= 0 || effective.height <= 0) {
      entry.view.setVisible(false);
      return;
    }
    entry.view.setBounds({
      x: -effective.width,
      y: -effective.height,
      width: effective.width,
      height: effective.height,
    });
    // The view now sits offscreen; forget the last onscreen rect so release
    // re-applies real geometry instead of coalescing against a stale one.
    entry.lastAppliedBounds = null;
    entry.overlayParked = true;
    entry.overlayAwaitingPaintAck = false;
    entry.view.setVisible(true);
  }

  private releaseEntries(
    overlayId: string,
    keyIds: readonly string[],
  ): BrowserViewTileKey[] {
    return keyIds
      .slice()
      .reverse()
      .flatMap((keyId): BrowserViewTileKey[] => {
        const entry = this.entries.getSurfaceByKey(keyId);
        if (entry === undefined) return [];
        entry.overlayOwnerIds = entry.overlayOwnerIds.filter(
          (ownerId) => ownerId !== overlayId,
        );
        if (entry.overlayOwnerIds.length > 0) {
          return [];
        }
        entry.overlaySnapshotStale = false;
        entry.overlayAwaitingPaintAck = false;
        entry.overlayParked = false;
        this.geometry.applyBounds(entry);
        this.geometry.applyVisibility(entry);
        return [toTileKey(requireSurface(entry))];
      });
  }
}
