import type {
  BrowserPrimaryProfileDelta,
  BrowserStoreKeyUnwrapResult,
  BrowserStoreKeyWrapResult,
  BrowserViewBridge,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewCertificateTrust,
  BrowserViewDebugSnapshot,
  BrowserViewDownloadCancel,
  BrowserViewDownloadChange,
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewTileCommandEvent,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

function tileId(key: BrowserViewTileKey): string {
  return `${key.viewTabId}:${key.paneId}:${key.tileInstanceId}:${key.pageSessionId}`;
}

/**
 * Shared occlusion-aware test double for `BrowserViewBridge`. It lives
 * outside any one suite (and is not named `*.test.ts`, so the runner does
 * not collect it) because both the coordinator/bridge suite and ticket 08's
 * fuzz suite need the SAME ownership/MISSED semantics - a second, simpler
 * fake would only drift from what this one actually models. See
 * `fake-browser-view-bridge.ts` for the plain (non-occlusion-aware) double
 * the rest of the app's tests use.
 */
export class FakeBrowserViewBridge implements BrowserViewBridge {
  readonly occludeCalls: BrowserViewOverlayOcclusion[] = [];
  /** Forces the `matchedCount` main reports, so a miss can be simulated. */
  matchedCountOverride: number | null = null;
  readonly releaseCalls: BrowserViewOverlayRelease[] = [];
  readonly paintAckCalls: string[] = [];
  /**
   * Mirrors main's per-tile refcount across owners (`BrowserViewOverlay`,
   * invariant 5): a tile with two active owners (an overlay and a motion
   * owner, say) is only reported as restored once the LAST owner releases -
   * a naive "release always restores" fake would falsely restore a tile
   * that a sibling owner still covers.
   */
  /**
   * `tilesByOverlayId` is also the source of truth for what each overlayId
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
  private readonly snapshotInvalidationHandlers = new Set<
    (change: BrowserViewSnapshotInvalidatedChange) => void
  >();
  private readonly overlayTileRestoredHandlers = new Set<
    (tile: BrowserViewTileKey) => void
  >();
  /** When set, `releaseOverlay` reports no synchronous restores - the
   * ticket-04 "was parked" case, whose tiles arrive later on
   * `emitOverlayTileRestored` instead. */
  deferRestoredTiles = false;

  upsertTile(): Promise<void> {
    return Promise.resolve();
  }

  setViewportPreset(): Promise<void> {
    return Promise.resolve();
  }

  updateBounds(): Promise<void> {
    return Promise.resolve();
  }

  releaseTile(): Promise<void> {
    return Promise.resolve();
  }

  reloadTile(): Promise<void> {
    return Promise.resolve();
  }

  goBack(): Promise<void> {
    return Promise.resolve();
  }

  goForward(): Promise<void> {
    return Promise.resolve();
  }

  findInPage(_input: BrowserViewFindRequest): Promise<void> {
    return Promise.resolve();
  }

  stopFindInPage(_input: BrowserViewFindStop): Promise<void> {
    return Promise.resolve();
  }

  cancelDownload(_input: BrowserViewDownloadCancel): Promise<void> {
    return Promise.resolve();
  }

  trustCertificate(_input: BrowserViewCertificateTrust): Promise<void> {
    return Promise.resolve();
  }

  zoomIn(_input: BrowserViewTileKey): Promise<void> {
    return Promise.resolve();
  }

  zoomOut(_input: BrowserViewTileKey): Promise<void> {
    return Promise.resolve();
  }

  resetZoom(_input: BrowserViewTileKey): Promise<void> {
    return Promise.resolve();
  }

  capturePage(
    input: BrowserViewTileKey,
  ): Promise<BrowserViewCapturePageResult> {
    return Promise.resolve({
      ...input,
      mediaType: "image/png",
      base64: "",
      byteLength: 0,
      sha256: "",
      capturedAt: 0,
    });
  }

  getDebugSnapshot(
    input: BrowserViewTileKey,
  ): Promise<BrowserViewDebugSnapshot> {
    return Promise.resolve({
      ...input,
      consoleEntries: [],
      networkEntries: [],
    });
  }

  startAnnotation(): Promise<{ readonly ok: true }> {
    return Promise.resolve({ ok: true });
  }

  cancelAnnotation(): Promise<void> {
    return Promise.resolve();
  }

  setAnnotationTargetChatLabel(): Promise<void> {
    return Promise.resolve();
  }
  reportAnnotationAttachResult(): Promise<void> {
    return Promise.resolve();
  }

  openDevTools(_input: BrowserViewTileKey): Promise<void> {
    return Promise.resolve();
  }

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

  occludeForOverlay(
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

  overlayPaintAck(overlayId: string): Promise<void> {
    this.paintAckCalls.push(overlayId);
    return Promise.resolve();
  }

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

  releaseOverlay(
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

  getSaveLogins(): Promise<boolean> {
    return Promise.resolve(true);
  }

  setSaveLogins(enabled: boolean): Promise<boolean> {
    return Promise.resolve(enabled);
  }

  wrapStoreKey(rawKey: string): Promise<BrowserStoreKeyWrapResult> {
    return Promise.resolve({ ok: true, wrappedKey: rawKey });
  }

  unwrapStoreKey(wrappedKey: string): Promise<BrowserStoreKeyUnwrapResult> {
    return Promise.resolve({ ok: true, rawKey: wrappedKey });
  }

  forgetLogins(): Promise<void> {
    return Promise.resolve();
  }

  onPrimaryProfileDelta(
    _handler: (delta: BrowserPrimaryProfileDelta) => void,
  ): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onFindChange(_handler: (change: BrowserViewFindChange) => void): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onDownloadChange(_handler: (change: BrowserViewDownloadChange) => void): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onCertificateError(
    _handler: (change: BrowserViewCertificateErrorChange) => void,
  ): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onOpenTileRequest(_handler: (change: BrowserViewOpenTileRequest) => void): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onTileCommand(_handler: (event: BrowserViewTileCommandEvent) => void): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onSnapshotInvalidated(
    handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ): {
    dispose: () => void;
  } {
    this.snapshotInvalidationHandlers.add(handler);
    return {
      dispose: () => {
        this.snapshotInvalidationHandlers.delete(handler);
      },
    };
  }

  onOverlayTileRestored(handler: (tile: BrowserViewTileKey) => void): {
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

  onAnnotationEvent(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onAnnotationAttached(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  setReservedChords(): Promise<void> {
    return Promise.resolve();
  }

  clearSite(): Promise<void> {
    return Promise.resolve();
  }

  evictSite(): Promise<void> {
    return Promise.resolve();
  }

  capturePrimaryProfile() {
    return Promise.resolve({
      status: "unavailable" as const,
      storageState: null,
      reason: "test",
    });
  }

  ensureTab() {
    return Promise.resolve({
      hostId: "host-test",
      sessionId: "session-test",
      tabId: "tab-test",
      registrationId: "registration-test",
    });
  }

  acceptTab(): Promise<void> {
    return Promise.resolve();
  }

  attachSurface(): Promise<void> {
    return Promise.resolve();
  }

  detachSurface(): Promise<void> {
    return Promise.resolve();
  }

  releaseTab(): Promise<boolean> {
    return Promise.resolve(true);
  }

  controlElectronTab(): Promise<void> {
    return Promise.resolve();
  }

  dispatchElectronTabCdp() {
    return Promise.resolve({
      kind: "cdpGetFrameTree" as const,
      ok: true as const,
      frames: [],
    });
  }

  startPipCapture(): Promise<void> {
    return Promise.resolve();
  }

  stopPipCapture(): Promise<void> {
    return Promise.resolve();
  }

  onPipCaptureFrame() {
    return { dispose: () => undefined };
  }

  onNativeTabStatusChange() {
    return { dispose: () => undefined };
  }

  emitSnapshotInvalidated(change: BrowserViewSnapshotInvalidatedChange): void {
    this.snapshotInvalidationHandlers.forEach((handler) => {
      handler(change);
    });
  }
}
