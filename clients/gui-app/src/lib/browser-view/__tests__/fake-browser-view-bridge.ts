import type {
  BrowserCookieCryptoState,
  BrowserPersistenceState,
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
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * Shared test double for the persistence members of `BrowserViewBridge`.
 *
 * It lives outside any one suite because two of them need it now (the hook's
 * own behaviour, and the persistence analytics funnel), and duplicating ~40
 * stubbed members is how two copies drift into disagreeing about the same
 * bridge. Not named `*.test.ts`, so the runner does not collect it.
 */
export function persistenceState(input: {
  readonly enabled: boolean;
}): BrowserPersistenceState {
  return {
    decision: input.enabled
      ? { kind: "enabled", decidedAt: 1 }
      : { kind: "undecided" },
    cryptoState: {
      mode: input.enabled ? "real" : "degraded",
      persistence: input.enabled ? "persistent" : "ephemeral",
      reason: input.enabled ? "os-backed" : "not-enabled",
      storageBackend: null,
      encryptionAvailable: input.enabled,
    },
    promptsOnEnable: true,
    appName: "Traycer",
    platform: "darwin",
  };
}

/**
 * `BrowserViewBridge` has dozens of members the hook never touches; every one
 * is still stubbed here so the class can `implements` the interface with no
 * cast. Only the five persistence members carry real behaviour.
 */
export class FakeBrowserViewBridge implements BrowserViewBridge {
  private readonly persistenceHandlers = new Set<
    (state: BrowserPersistenceState) => void
  >();
  private enableCallCount = 0;
  private nextEnableState: BrowserPersistenceState | null = null;

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
    });
  }

  releaseOverlay(
    _input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult> {
    return Promise.resolve({ restoredTiles: [] });
  }

  getCookieCryptoState(): Promise<BrowserCookieCryptoState> {
    return Promise.resolve({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
      storageBackend: null,
      encryptionAvailable: true,
    });
  }

  getPersistenceState(): Promise<BrowserPersistenceState> {
    return Promise.resolve(persistenceState({ enabled: false }));
  }

  enablePersistence(): Promise<BrowserPersistenceState> {
    this.enableCallCount += 1;
    const next = this.nextEnableState;
    return Promise.resolve(next ?? persistenceState({ enabled: true }));
  }

  /** What the NEXT (and every subsequent) enable resolves with - a denial, a
   * relaunch-pending machine, whatever the funnel under test needs. */
  setEnableOutcome(state: BrowserPersistenceState): void {
    this.nextEnableState = state;
  }

  declinePersistence(): Promise<BrowserPersistenceState> {
    return Promise.resolve(persistenceState({ enabled: false }));
  }

  relaunchForPersistence(): Promise<void> {
    return Promise.resolve();
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

  onPersistenceStateChanged(
    handler: (state: BrowserPersistenceState) => void,
  ): { dispose: () => void } {
    this.persistenceHandlers.add(handler);
    return {
      dispose: () => {
        this.persistenceHandlers.delete(handler);
      },
    };
  }

  onPrimaryProfileDelta(
    _handler: (delta: BrowserPrimaryProfileDelta) => void,
  ): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  overlayPaintAck(_overlayId: string): Promise<void> {
    return Promise.resolve();
  }

  clearSite() {
    return Promise.resolve({ status: "refused" as const, reason: "test" });
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

  onElectronTabHandoff() {
    return { dispose: () => undefined };
  }

  emitPersistenceState(state: BrowserPersistenceState): void {
    this.persistenceHandlers.forEach((handler) => {
      handler(state);
    });
  }

  persistenceEnableCallCount(): number {
    return this.enableCallCount;
  }
}
