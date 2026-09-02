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
  BrowserViewBridge,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
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
