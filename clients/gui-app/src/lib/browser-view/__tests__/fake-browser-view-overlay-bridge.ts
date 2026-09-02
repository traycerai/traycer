import type {
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { FakeBrowserViewBridge as PlainFakeBrowserViewBridge } from "./fake-browser-view-bridge";

function tileId(key: BrowserViewTileKey): string {
  return `${key.viewTabId}:${key.paneId}:${key.tileInstanceId}:${key.pageSessionId}`;
}

/**
 * Occlusion-aware test double for `BrowserViewBridge`. It EXTENDS the plain
 * fake (`fake-browser-view-bridge.ts`) rather than restating the ~40 stubbed
 * members of the bridge: only the overlay-ownership methods below differ, and
 * a second full copy of the interface is exactly how the two doubles drift
 * into disagreeing about the same bridge whenever `BrowserViewBridge` grows a
 * member.
 *
 * What it adds over the plain fake is a real per-tile owner refcount
 * (`overlayIdsByTileId`), mirroring main's `BrowserViewOverlay`: a tile with
 * two active owners (an overlay and a motion owner, say) is only reported as
 * restored once the LAST owner releases. Both the coordinator/bridge suite
 * and the fuzz suite need those same ownership/MISSED semantics.
 *
 * Not named `*.test.ts`, so the runner does not collect it.
 */
export class FakeBrowserViewBridge extends PlainFakeBrowserViewBridge {
  /**
   * `tilesByOverlayId` is the source of truth for what each overlayId
   * currently TARGETS (mirroring main's `entryKeysByOwnerId`,
   * `browser-view-overlay.ts:143-152`), not only what it has successfully
   * parked: `occludeForOverlay` sets it synchronously on every call, before
   * anything async, and diffs against the previous value to release
   * whatever tile dropped out of the new set - a tile the overlay no longer
   * requests must not stay parked under it.
   */
  private readonly tilesByOverlayId = new Map<
    string,
    readonly BrowserViewTileKey[]
  >();
  private readonly overlayIdsByTileId = new Map<string, Set<string>>();
  private readonly overlayTileRestoredHandlers = new Set<
    (tile: BrowserViewTileKey) => void
  >();
  /** When set, `releaseOverlay` reports no synchronous restores - the
   * ticket-04 "was parked" case, whose tiles arrive later on
   * `emitOverlayTileRestored` instead. */
  deferRestoredTiles = false;

  /**
   * Every tile actually reported restored to the coordinator - both from a
   * NON-deferred `releaseOverlay` (a deferred one reports `[]` here and the
   * tile later restores through `emitOverlayTileRestored` instead) and from
   * `occludeForOverlay`'s own diff-release, which the coordinator applies
   * through that same call's `restoredTiles` (`browser-overlay-coordinator-
   * bridge.tsx`'s `.then((result) => { ...; applyRestoredTiles(result.
   * restoredTiles); ... })`). A handoff test asserts this stays empty across
   * a same-scan ownership swap: a tile with a surviving owner must never
   * show up here.
   */
  readonly restoreReports: BrowserViewTileKey[] = [];

  /**
   * Drops `overlayId` as an owner of every tile in `tiles`, mirroring
   * `releaseEntries` (`browser-view-overlay.ts:366-`): a tile that reaches
   * zero owners is restored. Shared by `releaseOverlay` and by
   * `occludeForOverlay`'s own diff-release below - main's real `occlude()`
   * (`:143-152`) runs this SAME diff on every call, not just the first, so a
   * repeat call for an overlayId whose target set shrank (a tile it used to
   * cover but no longer does) must release the dropped tile right there,
   * not strand it parked forever.
   */
  private releaseOwnership(
    overlayId: string,
    tiles: readonly BrowserViewTileKey[],
  ): BrowserViewTileKey[] {
    const restored: BrowserViewTileKey[] = [];
    tiles.forEach((tile) => {
      const owners = this.overlayIdsByTileId.get(tileId(tile));
      owners?.delete(overlayId);
      if (owners === undefined || owners.size === 0) {
        this.overlayIdsByTileId.delete(tileId(tile));
        restored.push(tile);
      }
    });
    return restored;
  }

  override occludeForOverlay(
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    this.occludeCalls.push(input);

    // Mirrors main's real `occlude()` (`browser-view-overlay.ts:143-152`):
    // diff this call's tile set against what `overlayId` targeted last, and
    // release whatever dropped out - SYNCHRONOUSLY, before anything async,
    // and on EVERY call, not just a release. A tile an overlay used to cover
    // but no longer does (it moved, or the overlay's own rect shrank) must
    // not stay parked under an overlayId that no longer requests it.
    const previousTiles = this.tilesByOverlayId.get(input.overlayId) ?? [];
    const nextTileIds = new Set(input.tiles.map(tileId));
    const droppedTiles = previousTiles.filter(
      (tile) => !nextTileIds.has(tileId(tile)),
    );
    const restoredFromDrop = this.releaseOwnership(
      input.overlayId,
      droppedTiles,
    );
    this.restoreReports.push(...restoredFromDrop);
    this.tilesByOverlayId.set(input.overlayId, input.tiles);

    // Per-tile classification, mirroring `occludeEntry`
    // (`browser-view-overlay.ts:296-355`):
    //  - already owned by THIS overlayId (carried over from a previous
    //    call) -> already parked, nothing to do.
    //  - owned by ANOTHER overlayId -> warm: parked onto this overlayId
    //    SYNCHRONOUSLY (`:304-308`, `ALREADY_OCCLUDED` before any capture).
    //  - unowned -> cold: needs the post-microtask capture-race path below
    //    (`:317-338`).
    const coldTiles: BrowserViewTileKey[] = [];
    input.tiles.forEach((tile) => {
      const owners = this.overlayIdsByTileId.get(tileId(tile));
      if (owners !== undefined && owners.has(input.overlayId)) return;
      if (owners !== undefined && owners.size > 0) {
        owners.add(input.overlayId);
        return;
      }
      coldTiles.push(tile);
    });

    return Promise.resolve().then(() => {
      // Mirrors the MISSED guard at `browser-view-overlay.ts:333-334`: a
      // cold tile only settles if it is still part of `overlayId`'s CURRENT
      // target set - a later `occludeForOverlay`/`releaseOverlay` call for
      // this same overlayId that dropped it in the meantime must miss it
      // (and a `releaseOverlay` landing in the gap already undid every
      // synchronous warm add above too, via the same `tilesByOverlayId`
      // diff this call itself just ran), rather than parking it after the
      // fact.
      const currentTargetIds = new Set(
        (this.tilesByOverlayId.get(input.overlayId) ?? []).map(tileId),
      );
      coldTiles
        .filter((tile) => currentTargetIds.has(tileId(tile)))
        .forEach((tile) => {
          const owners = this.overlayIdsByTileId.get(tileId(tile)) ?? new Set();
          owners.add(input.overlayId);
          this.overlayIdsByTileId.set(tileId(tile), owners);
        });

      // Read back the final state rather than tracking a separate tally -
      // main's `matchedCount` is literally "how many of these tiles this
      // overlayId ended up occluding" (`results.filter(r => r.occluded).
      // length`, `:167`), so the fake asks the same question of its own
      // ownership map instead of re-deriving it.
      const occludedTiles = input.tiles.filter(
        (tile) =>
          this.overlayIdsByTileId.get(tileId(tile))?.has(input.overlayId) ??
          false,
      );
      const matchedCount = this.matchedCountOverride ?? occludedTiles.length;

      return {
        snapshots:
          matchedCount === 0
            ? []
            : input.tiles.map((tile) => ({
                ...tile,
                dataUrl: `data:image/png;base64,${input.overlayId}`,
                stale: false,
              })),
        restoredTiles: restoredFromDrop,
        matchedCount,
      };
    });
  }

  override releaseOverlay(
    input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult> {
    this.releaseCalls.push(input);
    const tiles = this.tilesByOverlayId.get(input.overlayId) ?? [];
    this.tilesByOverlayId.delete(input.overlayId);
    const restoredTiles = this.releaseOwnership(input.overlayId, tiles);
    const reported = this.deferRestoredTiles ? [] : restoredTiles;
    this.restoreReports.push(...reported);
    return Promise.resolve({
      restoredTiles: reported,
    });
  }

  override onOverlayTileRestored(handler: (tile: BrowserViewTileKey) => void): {
    dispose: () => void;
  } {
    this.overlayTileRestoredHandlers.add(handler);
    return {
      dispose: () => {
        this.overlayTileRestoredHandlers.delete(handler);
      },
    };
  }

  emitOverlayTileRestored(tile: BrowserViewTileKey): void {
    this.overlayTileRestoredHandlers.forEach((handler) => {
      handler(tile);
    });
  }

  /**
   * Whether `tile` currently has at least one owner in `overlayIdsByTileId` -
   * the same refcount main's real `restoredTiles` decision reads. This no
   * longer means "no pending ticket counts": a WARM tile (already owned when
   * a new `occludeForOverlay` call for it lands) is recorded here
   * SYNCHRONOUSLY, before that call's own ticket ever settles, mirroring
   * main's synchronous already-parked branch (`browser-view-overlay.ts:
   * 302-308`). Only a COLD tile's ownership still waits on its ticket
   * settling post-microtask.
   */
  isTileParked(tile: BrowserViewTileKey): boolean {
    const owners = this.overlayIdsByTileId.get(tileId(tile));
    return owners !== undefined && owners.size > 0;
  }
}
