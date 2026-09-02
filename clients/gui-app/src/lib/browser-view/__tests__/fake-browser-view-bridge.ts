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

/**
 * Shared test double for `BrowserViewBridge`. It lives outside any one suite
 * because several need it now, and duplicating ~40 stubbed members is how two
 * copies drift into disagreeing about the same bridge. Not named `*.test.ts`,
 * so the runner does not collect it.
 */
export class FakeBrowserViewBridge implements BrowserViewBridge {
  private saveLoginsValue: boolean;
  /**
   * A FACTORY, not a promise: a rejected promise handed in at arrange time is
   * already rejected while the test renders and waits, which surfaces as an
   * unhandled rejection well before the code under test ever attaches a
   * handler. Built inside `setSaveLogins`, it is rejected only once someone is
   * there to catch it.
   */
  private nextSetSaveLoginsResult: (() => Promise<boolean>) | null = null;

  constructor(input?: { readonly saveLogins?: boolean }) {
    this.saveLoginsValue = input?.saveLogins ?? true;
  }

  updateBounds(): Promise<void> {
    return Promise.resolve();
  }

  setReservedChords(): Promise<void> {
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

  occludeForOverlay(
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    return Promise.resolve({
      snapshots: input.tiles.map((tile) => ({
        ...tile,
        dataUrl: null,
        stale: false,
      })),
      restoredTiles: [],
      matchedCount: input.tiles.length,
    });
  }

  releaseOverlay(
    _input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult> {
    return Promise.resolve({ restoredTiles: [] });
  }

  getSaveLogins(): Promise<boolean> {
    return Promise.resolve(this.saveLoginsValue);
  }

  setSaveLogins(enabled: boolean): Promise<boolean> {
    const forced = this.nextSetSaveLoginsResult;
    if (forced !== null) {
      this.nextSetSaveLoginsResult = null;
      // A forced RESOLUTION is a settled write like any other, so the fake's
      // own state has to follow it - otherwise a later `getSaveLogins()`
      // answers with a value this bridge never settled on, and a remount or
      // refetch reads a state that never existed. A rejection settles nothing
      // and is left alone.
      return forced().then((settled) => {
        this.saveLoginsValue = settled;
        return settled;
      });
    }
    this.saveLoginsValue = enabled;
    return Promise.resolve(enabled);
  }

  /** Forces the NEXT `setSaveLogins` call to settle with what this returns
   * instead - a rejection, or a resolution that disagrees with what was
   * requested. Called at that moment, not now. */
  setNextSetSaveLoginsResult(result: () => Promise<boolean>): void {
    this.nextSetSaveLoginsResult = result;
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

  overlayPaintAck(_overlayId: string): Promise<void> {
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

  /** Captured so a suite can fire a browser-scoped chord at a tile. */
  tileCommandHandlers: Array<(event: BrowserViewTileCommandEvent) => void> = [];

  onTileCommand(handler: (event: BrowserViewTileCommandEvent) => void): {
    dispose: () => void;
  } {
    this.tileCommandHandlers.push(handler);
    return {
      dispose: () => {
        this.tileCommandHandlers = this.tileCommandHandlers.filter(
          (entry) => entry !== handler,
        );
      },
    };
  }

  onSnapshotInvalidated(
    _handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onAnnotationEvent() {
    return { dispose: () => undefined };
  }

  onAnnotationAttached() {
    return { dispose: () => undefined };
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
}
