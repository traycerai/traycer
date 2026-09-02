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
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
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
  BrowserViewTileCommandEvent,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewTileKey,
  BrowserViewBridge,
  BrowserPrimaryProfileDelta,
  BrowserStoreKeyUnwrapResult,
  BrowserStoreKeyWrapResult,
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
  /** Forces the `matchedCount` main reports, so a miss can be simulated. */
  matchedCountOverride: number | null = null;
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
      matchedCount: this.matchedCountOverride ?? input.tiles.length,
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

  it("retries an overlay whose occlusion matched no tile in main", async () => {
    // The signature used to be recorded before the occlude resolved, so a
    // scan that raced tile teardown ("no matching entries") was never retried
    // and the tile stayed live under the overlay until it closed.
    const bridge = new FakeBrowserViewBridge();
    bridge.matchedCountOverride = 0;
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("command-palette", rect(20, 20, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });

    bridge.matchedCountOverride = null;
    act(() => {
      overlay.setAttribute("data-state", "open");
    });

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    expect(bridge.occludeCalls[1]).toMatchObject({
      overlayId: "command-palette",
    });
    overlay.remove();
  });

  it("retries an overlay whose occlusion matched only SOME of its tiles", async () => {
    // A partial match leaves the unmatched tile live under the overlay. The
    // signature stayed latched on any nonzero count, so the next layout
    // notification computed the same signature and returned early.
    const bridge = new FakeBrowserViewBridge();
    bridge.matchedCountOverride = 1;
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    registerTestBrowserOverlayTile({
      key: { ...BASE_KEY, tileInstanceId: "tile-2" },
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay("command-palette", rect(20, 20, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toHaveLength(2);

    bridge.matchedCountOverride = null;
    act(() => {
      overlay.setAttribute("data-state", "open");
    });

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
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

  it("keeps a dialog occluded across a real Radix Select's aria-hidden churn", async () => {
    // The regression: Radix's hideOthers (fired by any Select/Popover/
    // DropdownMenu opening) sets aria-hidden="true" on every OTHER body
    // child while it's open - including a settings dialog that is itself a
    // direct body child via DialogPortal. The old `isElementVisible` treated
    // aria-hidden as "not painted", so the dialog dropped out of the next
    // scan's targets and got released while it still visibly covered the
    // tile. A bare-div overlay stand-in never exercises this: nothing calls
    // hideOthers on it, so this needs real Radix mount/unmount behavior.
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 300, 300),
    });

    // Controlled `open`, driven by rerender rather than a simulated click:
    // Radix's own dismissable-layer close (from a real outside click) would
    // race a second, test-owned click handler toggling the same state,
    // double-flipping it back open. A controlled prop still mounts/unmounts
    // the real `SelectContent` - and runs its real `hideOthers` effect - on
    // each transition, which is the behavior under test.
    function Harness(props: {
      readonly selectOpen: boolean;
    }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <Dialog open>
            <DialogContent>
              <Select
                open={props.selectOpen}
                onOpenChange={() => undefined}
                value="a"
                onValueChange={() => undefined}
              >
                <SelectTrigger aria-label="Pick">
                  <SelectValue placeholder="Pick" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">A</SelectItem>
                </SelectContent>
              </Select>
            </DialogContent>
          </Dialog>
        </SurfacePresentationBoundary>
      );
    }

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
      { browserView: bridge },
    );
    const view = render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <BrowserOverlayCoordinatorBridge />
        <Harness selectOpen={false} />
      </RunnerHostProvider>,
    );

    const dialogContent = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    if (dialogContent === null) throw new Error("dialog content not mounted");
    setElementRect(dialogContent, rect(0, 0, 200, 200));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const dialogOverlayId = bridge.occludeCalls[0].overlayId;

    // Open the Select: real Radix hideOthers churn, not a stubbed attribute.
    act(() => {
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness selectOpen />
        </RunnerHostProvider>,
      );
    });
    await waitFor(() => {
      expect(dialogContent.getAttribute("aria-hidden")).toBe("true");
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(false);

    // Close the Select again; the dialog is still open and still covers the
    // tile, so the scan that follows must not release it either - this is
    // the scan that catches a release-before-occlude ordering regression too.
    act(() => {
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness selectOpen={false} />
        </RunnerHostProvider>,
      );
    });
    await waitFor(() => {
      expect(dialogContent.hasAttribute("aria-hidden")).toBe(false);
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(false);
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
