import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { useBrowserViewBoundsBridge } from "@/components/epic-canvas/renderers/use-browser-view-bounds-bridge";
import {
  registerBrowserOverlayTile,
  updateBrowserOverlayTileRect,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import type {
  BrowserViewBoundsUpdate,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

vi.mock("@/lib/browser-view/tiles/browser-overlay-coordinator", () => ({
  rectFromDomRect: (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) => ({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }),
  registerBrowserOverlayTile: vi.fn(() => () => undefined),
  updateBrowserOverlayTileRect: vi.fn(),
}));

const registerMock = vi.mocked(registerBrowserOverlayTile);
const updateRectMock = vi.mocked(updateBrowserOverlayTileRect);

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-tab-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

interface ControllableResizeObserver {
  readonly observed: readonly Element[];
  emit(): void;
}

let activeObserver: ControllableResizeObserver | null = null;

class StubResizeObserver implements ResizeObserver {
  private readonly targets: Element[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    const controller: ControllableResizeObserver = {
      observed: this.targets,
      emit: () => {
        this.callback([], this);
      },
    };
    activeObserver = controller;
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }

  disconnect(): void {
    this.targets.length = 0;
  }
}

interface PendingFrame {
  readonly id: number;
  readonly callback: FrameRequestCallback;
}

let pendingFrames: PendingFrame[] = [];
let nextFrameId = 1;

function installFrameStub(): void {
  nextFrameId = 1;
  pendingFrames = [];
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextFrameId;
    nextFrameId += 1;
    pendingFrames.push({ id, callback });
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    pendingFrames = pendingFrames.filter((frame) => frame.id !== id);
  };
}

function flushFrames(): void {
  const frames = pendingFrames;
  pendingFrames = [];
  frames.forEach((frame) => {
    frame.callback(performance.now());
  });
}

function domRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRectReadOnly {
  return {
    x: left,
    y: top,
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    toJSON: () => undefined,
  };
}

interface Harness {
  readonly surface: HTMLDivElement;
  setRect(left: number, top: number, width: number, height: number): void;
  readonly sentBounds: BrowserViewBoundsUpdate[];
  observer(): ControllableResizeObserver;
}

function renderBridge(withBridge: boolean): Harness {
  const surface = document.createElement("div");
  document.body.appendChild(surface);
  const getBoundingClientRect = vi
    .spyOn(surface, "getBoundingClientRect")
    .mockReturnValue(domRect(8, 12, 400, 300));
  const surfaceRef: RefObject<HTMLDivElement | null> = { current: surface };
  const sentBounds: BrowserViewBoundsUpdate[] = [];
  const browserView = Object.assign(createFakeRunnerHost({}), {
    browserView: new Proxy<Record<string, unknown>>(
      {
        updateBounds: (input: BrowserViewBoundsUpdate) => {
          sentBounds.push(input);
          return Promise.resolve();
        },
      },
      {
        get: (target, property): unknown =>
          typeof property === "string"
            ? (target[property] ?? (() => undefined))
            : undefined,
      },
    ),
  }).browserView;

  renderHook(() =>
    useBrowserViewBoundsBridge({
      browserView: withBridge ? browserView : null,
      surfaceRef,
      tileKey: TILE_KEY,
      visible: true,
    }),
  );

  return {
    surface,
    setRect(left, top, width, height) {
      getBoundingClientRect.mockReturnValue(domRect(left, top, width, height));
    },
    sentBounds,
    observer() {
      if (activeObserver === null) throw new Error("no observer installed");
      return activeObserver;
    },
  };
}

describe("useBrowserViewBoundsBridge", () => {
  beforeEach(() => {
    installFrameStub();
    globalThis.ResizeObserver = StubResizeObserver;
  });

  afterEach(() => {
    cleanup();
    activeObserver = null;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("registers the tile with the mount-time rect and observes the surface", () => {
    const harness = renderBridge(true);

    expect(harness.observer().observed).toEqual([harness.surface]);
    expect(registerMock).toHaveBeenCalledWith({
      key: TILE_KEY,
      rect: { x: 8, y: 12, width: 400, height: 300 },
    });
  });

  it("updates the overlay registry immediately and coalesces a tick burst to the newest rect", () => {
    const harness = renderBridge(true);

    harness.setRect(0, 40, 420, 310);
    act(() => {
      harness.observer().emit();
      harness.observer().emit();
    });

    expect(updateRectMock).toHaveBeenLastCalledWith(TILE_KEY, {
      x: 0,
      y: 40,
      width: 420,
      height: 310,
    });
    expect(pendingFrames).toHaveLength(1);

    act(() => {
      flushFrames();
    });
    expect(harness.sentBounds).toHaveLength(1);
    expect(harness.sentBounds[0]).toMatchObject({
      tileInstanceId: TILE_KEY.tileInstanceId,
      bounds: { x: 0, y: 40, width: 420, height: 310 },
    });
  });

  it("never sends or registers zero-area rects", () => {
    const harness = renderBridge(true);
    act(() => {
      flushFrames();
    });
    updateRectMock.mockClear();
    harness.sentBounds.length = 0;

    harness.setRect(0, 0, 0, 0);
    act(() => {
      harness.observer().emit();
      flushFrames();
    });

    expect(harness.sentBounds).toHaveLength(0);
    expect(updateRectMock).not.toHaveBeenCalled();
  });

  it("cancels a pending frame and unregisters on unmount", () => {
    const harness = renderBridge(true);

    harness.setRect(4, 4, 200, 100);
    act(() => {
      harness.observer().emit();
    });
    expect(pendingFrames).toHaveLength(1);

    cleanup();
    act(() => {
      flushFrames();
    });

    expect(harness.sentBounds).toHaveLength(0);
    expect(harness.observer().observed).toEqual([]);
  });

  it("does not register anything without a desktop bridge", () => {
    renderBridge(false);

    expect(registerMock).not.toHaveBeenCalled();
    expect(activeObserver).toBeNull();
  });
});
