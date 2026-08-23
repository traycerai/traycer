import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { BrowserOverlayCoordinatorBridge } from "@/components/epic-canvas/browser-overlay-coordinator";
import {
  clearBrowserViewSnapshot,
  getBrowserViewSnapshot,
  registerBrowserOverlayTile,
  resetBrowserOverlayCoordinatorForTests,
  type BrowserOverlayRect,
} from "@/lib/browser-view/browser-overlay-coordinator";
import type {
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewCertificateErrorChange,
  BrowserViewCertificateTrust,
  BrowserViewCapturePageResult,
  BrowserViewControlAction,
  BrowserViewControlActionResult,
  BrowserViewControlGrant,
  BrowserViewControlGrantResult,
  BrowserViewControlRevokedChange,
  BrowserViewControlRevoke,
  BrowserViewDownloadCancel,
  BrowserViewDownloadChange,
  BrowserViewDebugSnapshotChange,
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewStatusChange,
  BrowserViewTileKey,
  DesktopBrowserViewBridge,
} from "@/lib/browser-view/desktop-browser-view";
import type {
  AgentBrowserViewBoundsUpdate,
  AgentBrowserViewCdpDispatch,
  AgentBrowserViewCdpResult,
  AgentBrowserViewCdpSessionEndedChange,
  AgentBrowserViewCdpTargetAttachedChange,
  AgentBrowserViewDurableTabRegistration,
  AgentBrowserViewStatusChange,
  AgentBrowserViewTileHandoffChange,
  AgentBrowserViewTileUpsert,
  DesktopAgentBrowserViewBridge,
} from "@/lib/browser-view/desktop-agent-browser-view";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const BASE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

class FakeBrowserViewBridge implements DesktopBrowserViewBridge {
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

  registerDurableTab(): Promise<void> {
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
  ): Promise<BrowserViewDebugSnapshotChange> {
    return Promise.resolve({
      ...input,
      consoleEntries: [],
      networkEntries: [],
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

  grantControl(
    input: BrowserViewControlGrant,
  ): Promise<BrowserViewControlGrantResult> {
    return Promise.resolve({ status: "granted", controlId: input.controlId });
  }

  revokeControl(_input: BrowserViewControlRevoke): Promise<void> {
    return Promise.resolve();
  }

  executeControlAction(
    _input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    return Promise.resolve({ status: "completed", value: null });
  }

  getCookieCryptoState(): Promise<{
    readonly mode: "real";
    readonly persistence: "persistent";
    readonly reason: "os-backed";
    readonly storageBackend: null;
    readonly encryptionAvailable: true;
    readonly mockKeychainEnabled: false;
  }> {
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

  applyStorageState(): Promise<{
    readonly status: "applied";
    readonly cookieCount: 0;
    readonly localStorageApplied: false;
    readonly reason: "cookies-only";
  }> {
    return Promise.resolve({
      status: "applied",
      cookieCount: 0,
      localStorageApplied: false,
      reason: "cookies-only",
    });
  }

  captureStorageState(): Promise<{
    readonly storageState: { readonly cookies: []; readonly origins: [] };
    readonly cookieCount: 0;
    readonly cookieDomains: [];
    readonly localStorageCount: 0;
    readonly localStorageAvailable: true;
    readonly localStorageReason: null;
  }> {
    return Promise.resolve({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: true,
      localStorageReason: null,
    });
  }

  onStatusChange(_handler: (change: BrowserViewStatusChange) => void): {
    dispose: () => void;
  } {
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

  onDebugSnapshotChange(
    _handler: (change: BrowserViewDebugSnapshotChange) => void,
  ): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onControlRevoked(
    _handler: (change: BrowserViewControlRevokedChange) => void,
  ): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onAnnotationEvent(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onAnnotationAttached(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  // Ticket 09's borrowed-tile CDP members. This fake exists to exercise the
  // overlay coordinator, which never drives a tile, so they are inert here -
  // the borrowed-tile behaviour has its own tests rather than riding on this
  // one's fake.
  dispatchCdp(): Promise<AgentBrowserViewCdpResult> {
    return Promise.resolve({
      kind: "cdpGetFrameTree",
      ok: false,
      error: {
        kind: "tile_not_found",
        message: "Fake bridge does not dispatch CDP.",
        code: null,
      },
    });
  }

  onCdpSessionEnded(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onCdpTargetAttached(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onTileHandoff(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  emitSnapshotInvalidated(change: BrowserViewSnapshotInvalidatedChange): void {
    this.snapshotInvalidationHandlers.forEach((handler) => {
      handler(change);
    });
  }
}

class FakeAgentBrowserViewBridge implements DesktopAgentBrowserViewBridge {
  readonly occludeCalls: BrowserViewOverlayOcclusion[] = [];
  readonly releaseCalls: BrowserViewOverlayRelease[] = [];
  private readonly snapshotInvalidationHandlers = new Set<
    (change: BrowserViewSnapshotInvalidatedChange) => void
  >();

  upsertTile(_input: AgentBrowserViewTileUpsert): Promise<void> {
    return Promise.resolve();
  }

  registerDurableTab(
    _input: AgentBrowserViewDurableTabRegistration,
  ): Promise<void> {
    return Promise.resolve();
  }

  updateBounds(_input: AgentBrowserViewBoundsUpdate): Promise<void> {
    return Promise.resolve();
  }

  releaseTile(_input: BrowserViewTileKey): Promise<void> {
    return Promise.resolve();
  }

  onStatusChange(_handler: (change: AgentBrowserViewStatusChange) => void): {
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

  setViewportPreset(): Promise<void> {
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

  findInPage(): Promise<void> {
    return Promise.resolve();
  }

  stopFindInPage(): Promise<void> {
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

  openDevTools(): Promise<void> {
    return Promise.resolve();
  }

  onFindChange(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onDownloadChange(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onCertificateError(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  dispatchCdp(
    _input: AgentBrowserViewCdpDispatch,
  ): Promise<AgentBrowserViewCdpResult> {
    throw new Error("dispatchCdp is not exercised by this test");
  }

  occludeForOverlay(
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    this.occludeCalls.push(input);
    return Promise.resolve({ snapshots: [], restoredTiles: [] });
  }

  releaseOverlay(
    input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult> {
    this.releaseCalls.push(input);
    return Promise.resolve({ restoredTiles: [] });
  }

  onCdpSessionEnded(
    _handler: (change: AgentBrowserViewCdpSessionEndedChange) => void,
  ): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onCdpTargetAttached(
    _handler: (change: AgentBrowserViewCdpTargetAttachedChange) => void,
  ): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onTileHandoff(
    _handler: (change: AgentBrowserViewTileHandoffChange) => void,
  ): { dispose: () => void } {
    return { dispose: () => undefined };
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
    clearBrowserViewSnapshot(BASE_KEY);
    resetBrowserOverlayCoordinatorForTests();
    vi.restoreAllMocks();
  });

  it("does not hide browser views for non-overlapping overlays", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("palette", rect(200, 200, 40, 40));

    renderBrowserOverlayCoordinator(bridge, null);
    await Promise.resolve();

    expect(bridge.occludeCalls).toEqual([]);
    overlay.remove();
  });

  it("occludes every overlapping overlay through the desktop bridge", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const commandPalette = appendOverlay(
      "command-palette",
      rect(20, 20, 20, 20),
    );
    const toast = appendOverlay("toast", rect(80, 80, 40, 40));

    renderBrowserOverlayCoordinator(bridge, null);

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
    registerBrowserOverlayTile({
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

    renderBrowserOverlayCoordinator(bridge, null);

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
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const toaster = appendSonnerToaster(rect(16, 16, 48, 24));

    renderBrowserOverlayCoordinator(bridge, null);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
    expect(bridge.occludeCalls[0]?.overlayId).toMatch(/^browser-overlay-/);

    toaster.remove();
  });

  it("releases and clears snapshots when an overlay stops intersecting", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("dropdown", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge, null);
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
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("hover-card", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge, null);
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

  it("broadcasts the same occlude and release call to both the primary and agent bridges (fix round 3)", async () => {
    const bridge = new FakeBrowserViewBridge();
    const agentBridge = new FakeAgentBrowserViewBridge();
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("settings-dialog", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge, agentBridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
      expect(agentBridge.occludeCalls).toHaveLength(1);
    });
    // Both bridges receive the identical, full tile list - neither the
    // coordinator nor the renderer-side registry needs to know which
    // manager actually owns BASE_KEY; each manager silently no-ops the
    // tiles it does not own.
    expect(bridge.occludeCalls[0]).toEqual(agentBridge.occludeCalls[0]);
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);

    overlay.remove();
    await waitFor(() => {
      expect(bridge.releaseCalls).toHaveLength(1);
      expect(agentBridge.releaseCalls).toHaveLength(1);
    });
    expect(bridge.releaseCalls[0]).toEqual(agentBridge.releaseCalls[0]);
  });

  it("still occludes when only the primary bridge is available (agent bridge null)", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("settings-dialog", rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge, null);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });

    overlay.remove();
  });
});

function renderBrowserOverlayCoordinator(
  browserView: DesktopBrowserViewBridge,
  agentBrowserView: DesktopAgentBrowserViewBridge | null,
): void {
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
    { browserView, agentBrowserView },
  );
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <BrowserOverlayCoordinatorBridge />
    </RunnerHostProvider>,
  );
}

function appendOverlay(
  kind: string,
  overlayRect: BrowserOverlayRect,
): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-browser-overlay", kind);
  element.setAttribute("data-browser-overlay-id", kind);
  setElementRect(element, overlayRect);
  document.body.append(element);
  return element;
}

function appendSonnerToaster(overlayRect: BrowserOverlayRect): HTMLElement {
  const element = document.createElement("ol");
  element.setAttribute("data-sonner-toaster", "");
  setElementRect(element, overlayRect);
  document.body.append(element);
  return element;
}

function setElementRect(
  element: HTMLElement,
  overlayRect: BrowserOverlayRect,
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => toDomRect(overlayRect),
  });
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): BrowserOverlayRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function toDomRect(overlayRect: BrowserOverlayRect): DOMRect {
  return {
    x: overlayRect.left,
    y: overlayRect.top,
    width: overlayRect.width,
    height: overlayRect.height,
    top: overlayRect.top,
    right: overlayRect.right,
    bottom: overlayRect.bottom,
    left: overlayRect.left,
    toJSON: () => ({}),
  };
}
