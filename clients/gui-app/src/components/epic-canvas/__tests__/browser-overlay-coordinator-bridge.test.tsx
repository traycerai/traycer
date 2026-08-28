import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { BrowserOverlayCoordinatorBridge } from "@/components/epic-canvas/browser-overlay-coordinator-bridge";
import {
  clearBrowserViewSnapshot,
  getBrowserViewSnapshot,
  registerBrowserOverlayTile,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import type {
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewCertificateErrorChange,
  BrowserViewCertificateTrust,
  BrowserViewCapturePageResult,
  BrowserViewDownloadCancel,
  BrowserViewDownloadChange,
  BrowserViewDebugSnapshot,
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewTileKey,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const BASE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

const unregisterTiles = new Set<() => void>();

function registerTestBrowserOverlayTile(input: {
  readonly key: BrowserViewTileKey;
  readonly rect: DOMRectReadOnly;
}): void {
  unregisterTiles.add(registerBrowserOverlayTile(input));
}

class FakeBrowserViewBridge implements BrowserViewBridge {
  readonly occludeCalls: BrowserViewOverlayOcclusion[] = [];
  readonly releaseCalls: BrowserViewOverlayRelease[] = [];
  readonly paintAckCalls: string[] = [];
  private readonly snapshotInvalidationHandlers = new Set<
    (change: BrowserViewSnapshotInvalidatedChange) => void
  >();

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

  occludeForOverlay(
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    this.occludeCalls.push(input);
    return Promise.resolve({
      snapshots: input.tiles.map((tile) => ({
        ...tile,
        dataUrl: `data:image/png;base64,${input.overlayId}`,
        stale: false,
      })),
      restoredTiles: [],
    });
  }

  overlayPaintAck(overlayId: string): Promise<void> {
    this.paintAckCalls.push(overlayId);
    return Promise.resolve();
  }

  releaseOverlay(
    input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult> {
    this.releaseCalls.push(input);
    return Promise.resolve({ restoredTiles: [BASE_KEY] });
  }

  getCookieCryptoState(): Promise<{
    readonly mode: "real";
    readonly persistence: "persistent";
    readonly reason: "os-backed";
    readonly storageBackend: null;
    readonly encryptionAvailable: true;
  }> {
    return Promise.resolve({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
      storageBackend: null,
      encryptionAvailable: true,
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

  onAnnotationEvent(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onAnnotationAttached(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  setReservedChords(): Promise<void> {
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

  onElectronTabHandoff() {
    return { dispose: () => undefined };
  }

  emitSnapshotInvalidated(change: BrowserViewSnapshotInvalidatedChange): void {
    this.snapshotInvalidationHandlers.forEach((handler) => {
      handler(change);
    });
  }
}

describe("<BrowserOverlayCoordinator />", () => {
  beforeEach(() => {
    let nextFrameId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      setTimeout(() => {
        callback(performance.now());
      }, 0);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      (_handle) => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    unregisterTiles.forEach((unregister) => unregister());
    unregisterTiles.clear();
    clearBrowserViewSnapshot(BASE_KEY);
    vi.restoreAllMocks();
  });

  it("does not hide browser views for non-overlapping overlays", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("palette", rect(200, 200, 40, 40));

    renderBrowserOverlayCoordinator(bridge);
    await Promise.resolve();

    expect(bridge.occludeCalls).toEqual([]);
    overlay.remove();
  });

  it("occludes every overlapping overlay through the desktop bridge", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const commandPalette = appendOverlay(
      "command-palette",
      rect(20, 20, 20, 20),
    );
    const toast = appendOverlay("toast", rect(80, 80, 40, 40));

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    expect(bridge.occludeCalls.map((call) => call.overlayId).sort()).toEqual([
      "command-palette",
      "toast",
    ]);
    expect(
      bridge.occludeCalls.every((call) => call.tiles[0] === BASE_KEY),
    ).toBe(true);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).toEqual({
        dataUrl: "data:image/png;base64,toast",
        stale: false,
      });
    });

    // Flicker fix phase 2: once the replacement frame is applied, the
    // coordinator acknowledges so main parks the native view. Each overlay
    // acks its own replacement frame; main-side parking is idempotent.
    await waitFor(() => {
      expect(bridge.paintAckCalls.slice().sort()).toEqual([
        "command-palette",
        "toast",
      ]);
    });

    commandPalette.remove();
    toast.remove();
  });

  it("routes the registered overlay categories through one occlusion path", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const categories = [
      "command-palette",
      "context-menu",
      "toast",
      "find-bar",
      "hover-card",
      "dropdown-menu",
      "migration-dialog",
      "drag-overlay",
    ];
    const overlays = categories.map((category, index) =>
      appendOverlay(category, rect(5 + index, 5 + index, 20, 20)),
    );

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(categories.length);
    });
    expect(bridge.occludeCalls.map((call) => call.overlayId).sort()).toEqual(
      categories.toSorted(),
    );

    overlays.forEach((overlay) => overlay.remove());
  });

  it("measures Sonner's fixed toaster container as toast overlay geometry", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const toaster = appendSonnerToaster(rect(16, 16, 48, 24));

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
    expect(bridge.occludeCalls[0]?.overlayId).toMatch(/^browser-overlay-/);

    toaster.remove();
  });

  it("releases and clears snapshots when an overlay stops intersecting", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("dropdown", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });

    await act(async () => {
      overlay.remove();
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(bridge.releaseCalls).toEqual([{ overlayId: "dropdown" }]);
    });
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).toBeNull();
    });
  });

  it("marks a rendered snapshot stale from desktop invalidation events", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("hover-card", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).toEqual({
        dataUrl: "data:image/png;base64,hover-card",
        stale: false,
      });
    });

    bridge.emitSnapshotInvalidated({ ...BASE_KEY, reason: "paint" });

    expect(getBrowserViewSnapshot(BASE_KEY)).toEqual({
      dataUrl: "data:image/png;base64,hover-card",
      stale: true,
    });
    overlay.remove();
  });

  it("occludes through the native browser bridge", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("settings-dialog", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });

    overlay.remove();
  });
});

function renderBrowserOverlayCoordinator(browserView: BrowserViewBridge): void {
  const runnerHost = Object.assign(
    new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    { browserView },
  );
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <BrowserOverlayCoordinatorBridge />
    </RunnerHostProvider>,
  );
}

function appendOverlay(
  kind: string,
  overlayRect: DOMRectReadOnly,
): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-browser-overlay", kind);
  element.setAttribute("data-browser-overlay-id", kind);
  setElementRect(element, overlayRect);
  document.body.append(element);
  return element;
}

function appendSonnerToaster(overlayRect: DOMRectReadOnly): HTMLElement {
  const element = document.createElement("ol");
  element.setAttribute("data-sonner-toaster", "");
  setElementRect(element, overlayRect);
  document.body.append(element);
  return element;
}

function setElementRect(
  element: HTMLElement,
  overlayRect: DOMRectReadOnly,
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => overlayRect,
  });
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRectReadOnly {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}
