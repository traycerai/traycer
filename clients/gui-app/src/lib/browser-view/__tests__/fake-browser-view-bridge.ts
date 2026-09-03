import type {
  BrowserSessionsStreamEventEnvelope,
  BrowserSessionsStreamKey,
  BrowserSessionsStreamSend,
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
  BrowserViewAttachSurface,
  BrowserViewDetachSurface,
  BrowserViewGuestMountRequested,
  BrowserViewGuestReleaseRequested,
  BrowserViewReservedChord,
  BrowserViewTileCommandEvent,
  BrowserViewTileKey,
  LoginImportRequest,
  LoginImportResult,
  LoginImportScan,
  LoginImportSource,
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

  readonly reservedChordsCalls: BrowserViewReservedChord[][] = [];
  readonly openSessionsStreamCalls: BrowserSessionsStreamKey[] = [];
  readonly closeSessionsStreamCalls: BrowserSessionsStreamKey[] = [];
  readonly sendSessionsFrameCalls: BrowserSessionsStreamSend[] = [];
  private sessionsStreamEventHandler:
    | ((envelope: BrowserSessionsStreamEventEnvelope) => void)
    | null = null;
  private readonly guestMountHandlers = new Set<
    (request: BrowserViewGuestMountRequested) => void
  >();
  private readonly guestReleaseHandlers = new Set<
    (request: BrowserViewGuestReleaseRequested) => void
  >();

  constructor(input?: { readonly saveLogins?: boolean }) {
    this.saveLoginsValue = input?.saveLogins ?? true;
  }

  setReservedChords(
    chords: readonly BrowserViewReservedChord[],
  ): Promise<void> {
    this.reservedChordsCalls.push([...chords]);
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

  forgetLogins(): Promise<boolean> {
    return Promise.resolve(true);
  }

  clearSite(): Promise<void> {
    return Promise.resolve();
  }

  openSessionsStream(input: BrowserSessionsStreamKey): Promise<void> {
    this.openSessionsStreamCalls.push(input);
    return Promise.resolve();
  }

  closeSessionsStream(key: BrowserSessionsStreamKey): Promise<void> {
    this.closeSessionsStreamCalls.push(key);
    return Promise.resolve();
  }

  sendSessionsFrame(input: BrowserSessionsStreamSend): Promise<void> {
    this.sendSessionsFrameCalls.push(input);
    return Promise.resolve();
  }

  onSessionsStreamEvent(
    handler: (envelope: BrowserSessionsStreamEventEnvelope) => void,
  ): { dispose: () => void } {
    this.sessionsStreamEventHandler = handler;
    return {
      dispose: () => {
        if (this.sessionsStreamEventHandler === handler) {
          this.sessionsStreamEventHandler = null;
        }
      },
    };
  }

  /** Drives whatever suite is holding the coordinator's subscription. */
  emitSessionsStreamEvent(envelope: BrowserSessionsStreamEventEnvelope): void {
    this.sessionsStreamEventHandler?.(envelope);
  }

  clearSavedLoginSite(): Promise<boolean> {
    return Promise.resolve(true);
  }

  listLoginImportSources(): Promise<readonly LoginImportSource[]> {
    return Promise.resolve([]);
  }

  pickLoginImportFile(): Promise<LoginImportSource | null> {
    return Promise.resolve(null);
  }

  scanLoginImportSource(sourceId: string): Promise<LoginImportScan> {
    return Promise.resolve({
      sourceId,
      scanId: `scan-${sourceId}`,
      sites: [],
      excluded: [],
      protectedCookieCount: 0,
      partitionedCookieCount: 0,
      unreadableCookieCount: 0,
      unlock: null,
      blocked: null,
    });
  }

  importLogins(_input: LoginImportRequest): Promise<LoginImportResult> {
    return Promise.resolve({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
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

  onAnnotationEvent() {
    return { dispose: () => undefined };
  }

  onAnnotationAttached() {
    return { dispose: () => undefined };
  }

  /** Attaches and detaches in ONE list: their ORDER is what main enforces. */
  readonly surfaceCalls: string[] = [];

  attachSurface(input: BrowserViewAttachSurface): Promise<void> {
    this.surfaceCalls.push(`attach:${input.bindingId}`);
    return Promise.resolve();
  }

  detachSurface(input: BrowserViewDetachSurface): Promise<void> {
    this.surfaceCalls.push(`detach:${input.bindingId}`);
    return Promise.resolve();
  }

  controlElectronTab(): Promise<void> {
    return Promise.resolve();
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

  onGuestMountRequested(
    handler: (request: BrowserViewGuestMountRequested) => void,
  ): { dispose: () => void } {
    this.guestMountHandlers.add(handler);
    return {
      dispose: () => {
        this.guestMountHandlers.delete(handler);
      },
    };
  }

  onGuestReleaseRequested(
    handler: (request: BrowserViewGuestReleaseRequested) => void,
  ): { dispose: () => void } {
    this.guestReleaseHandlers.add(handler);
    return {
      dispose: () => {
        this.guestReleaseHandlers.delete(handler);
      },
    };
  }

  emitGuestMountRequested(request: BrowserViewGuestMountRequested): void {
    for (const handler of this.guestMountHandlers) handler(request);
  }

  emitGuestReleaseRequested(request: BrowserViewGuestReleaseRequested): void {
    for (const handler of this.guestReleaseHandlers) handler(request);
  }
}
