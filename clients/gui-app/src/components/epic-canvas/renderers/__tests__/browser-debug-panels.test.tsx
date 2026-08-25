import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserDebugPanels } from "@/components/epic-canvas/renderers/browser-debug-panels";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  BrowserCookieCryptoState,
  BrowserViewCertificateErrorChange,
  BrowserViewConsoleEntry,
  BrowserViewDebugSnapshotChange,
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
  BrowserViewStatusChange,
  BrowserViewTileKey,
  BrowserViewNetworkEntry,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

const TILE: BrowserViewTileKey = {
  viewTabId: "view-tab",
  paneId: "pane",
  tileInstanceId: "tile",
  pageSessionId: "page",
};

function consoleEntry(
  overrides: Partial<BrowserViewConsoleEntry>,
): BrowserViewConsoleEntry {
  return {
    id: "console-1",
    timestamp: 1,
    source: "page",
    level: "log",
    text: "hello",
    url: "https://example.com",
    lineNumber: null,
    columnNumber: null,
    stackTrace: [],
    ...overrides,
  };
}

function networkEntry(
  overrides: Partial<BrowserViewNetworkEntry>,
): BrowserViewNetworkEntry {
  return {
    id: "network-1",
    requestId: "request-1",
    url: "https://example.com/data.json",
    method: "GET",
    resourceType: "fetch",
    status: "finished",
    statusCode: 200,
    statusText: "OK",
    mimeType: "application/json",
    fromCache: false,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    encodedDataLength: 10,
    failureText: null,
    ...overrides,
  };
}

function snapshot(
  consoleEntries: readonly BrowserViewConsoleEntry[],
  networkEntries: readonly BrowserViewNetworkEntry[],
): BrowserViewDebugSnapshotChange {
  return { ...TILE, consoleEntries, networkEntries };
}

const disposable = { dispose: () => undefined };

class FakeBrowserViewBridge implements BrowserViewBridge {
  private snapshotState = snapshot([], []);
  private readonly debugHandlers = new Set<
    (change: BrowserViewDebugSnapshotChange) => void
  >();

  upsertTile(): Promise<void> {
    return Promise.resolve();
  }

  updateBounds(): Promise<void> {
    return Promise.resolve();
  }

  setViewportPreset(): Promise<void> {
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

  cancelDownload(): Promise<void> {
    return Promise.resolve();
  }

  trustCertificate(): Promise<void> {
    return Promise.resolve();
  }

  zoomIn(): Promise<void> {
    return Promise.resolve();
  }

  zoomOut(): Promise<void> {
    return Promise.resolve();
  }

  resetZoom(): Promise<void> {
    return Promise.resolve();
  }

  capturePage(input: BrowserViewTileKey) {
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
  ): Promise<BrowserViewDebugSnapshotChange> {
    return Promise.resolve({
      ...input,
      consoleEntries: this.snapshotState.consoleEntries,
      networkEntries: this.snapshotState.networkEntries,
    });
  }

  clearDebugEvents(): Promise<void> {
    return Promise.resolve();
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

  openDevTools(): Promise<void> {
    return Promise.resolve();
  }

  occludeForOverlay(
    _input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    return Promise.resolve({ snapshots: [], restoredTiles: [] });
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
      mockKeychainEnabled: false,
    });
  }

  setLabsState(): Promise<void> {
    return Promise.resolve();
  }

  applyStorageState() {
    return Promise.resolve({
      status: "applied" as const,
      cookieCount: 0,
      localStorageApplied: false as const,
      reason: "cookies-only" as const,
    });
  }

  captureStorageState() {
    return Promise.resolve({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: true,
      localStorageReason: null,
    });
  }

  onStatusChange(_handler: (change: BrowserViewStatusChange) => void) {
    return disposable;
  }

  onFindChange(_handler: (change: BrowserViewFindChange) => void) {
    return disposable;
  }

  onDownloadChange(_handler: (change: BrowserViewDownloadChange) => void) {
    return disposable;
  }

  onCertificateError(
    _handler: (change: BrowserViewCertificateErrorChange) => void,
  ) {
    return disposable;
  }

  onOpenTileRequest(_handler: (change: BrowserViewOpenTileRequest) => void) {
    return disposable;
  }

  onSnapshotInvalidated(
    _handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ) {
    return disposable;
  }

  onDebugSnapshotChange(
    handler: (change: BrowserViewDebugSnapshotChange) => void,
  ) {
    this.debugHandlers.add(handler);
    return {
      dispose: () => {
        this.debugHandlers.delete(handler);
      },
    };
  }

  onAnnotationEvent() {
    return disposable;
  }

  onAnnotationAttached() {
    return disposable;
  }

  setReservedChords(): Promise<void> {
    return Promise.resolve();
  }

  overlayPaintAck(): Promise<void> {
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
    return disposable;
  }

  onNativeTabStatusChange() {
    return disposable;
  }

  onElectronTabHandoff() {
    return disposable;
  }

  emitSnapshot(next: BrowserViewDebugSnapshotChange): void {
    this.snapshotState = next;
    this.debugHandlers.forEach((handler) => handler(next));
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderPanels(bridge: FakeBrowserViewBridge): void {
  render(
    <TooltipProvider>
      <BrowserDebugPanels
        browserView={bridge}
        tileKey={TILE}
        pageUrl="https://example.com"
        status="ready"
        targetChatId={null}
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("<BrowserDebugPanels />", () => {
  it("starts collapsed without reserving the full tab panel", async () => {
    const bridge = new FakeBrowserViewBridge();

    renderPanels(bridge);

    expect(screen.getByTestId("browser-debug-panels-collapsed")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    await flushEffects();
    expect(screen.getByText("Console 0")).toBeTruthy();
    expect(screen.getByText("Network 0")).toBeTruthy();
  });

  it("updates collapsed counts and tints rows with errors or failed requests", async () => {
    const bridge = new FakeBrowserViewBridge();

    renderPanels(bridge);
    await flushEffects();
    act(() => {
      bridge.emitSnapshot(
        snapshot(
          [
            consoleEntry({ id: "console-1", level: "error" }),
            consoleEntry({ id: "console-2", level: "info" }),
          ],
          [networkEntry({ id: "network-1", status: "failed" })],
        ),
      );
    });
    await flushEffects();

    const consoleRow = screen.getByText("Console 2 · 1 error");
    const networkRow = screen.getByText("Network 1 · 1 failed");
    expect(consoleRow.className).toContain("text-destructive");
    expect(networkRow.className).toContain("text-destructive");
  });

  it("keeps the collapsed row live as debug snapshots change", async () => {
    const bridge = new FakeBrowserViewBridge();

    renderPanels(bridge);
    await flushEffects();
    act(() => {
      bridge.emitSnapshot(
        snapshot([consoleEntry({}), consoleEntry({ id: "console-2" })], []),
      );
    });
    await flushEffects();
    expect(screen.getByText("Console 2")).toBeTruthy();

    act(() => {
      bridge.emitSnapshot(snapshot([consoleEntry({ id: "console-new" })], []));
    });
    await flushEffects();
    expect(screen.getByText("Console 1")).toBeTruthy();
    expect(screen.queryByText("Console 2")).toBeNull();
  });

  it("expands to tabs and collapses back to the slim row", async () => {
    const bridge = new FakeBrowserViewBridge();

    renderPanels(bridge);
    await flushEffects();
    fireEvent.click(screen.getByTestId("browser-debug-panels-collapsed"));

    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Collapse console and network" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse console and network" }),
    );

    expect(screen.getByTestId("browser-debug-panels-collapsed")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
