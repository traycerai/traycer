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

/** Runs exactly the frames scheduled so far; the loop re-arms itself. */
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
  clipTo(left: number, top: number, width: number, height: number): void;
  readonly sentBounds: BrowserViewBoundsUpdate[];
}

function renderBridge(withBridge: boolean): Harness {
  const clipper = document.createElement("div");
  // Longhands: jsdom's computed style does not expand the `overflow`
  // shorthand. Set before mount - the clip chain is resolved per mount.
  clipper.style.overflowX = "hidden";
  clipper.style.overflowY = "hidden";
  const surface = document.createElement("div");
  clipper.appendChild(surface);
  document.body.appendChild(clipper);
  const getBoundingClientRect = vi
    .spyOn(surface, "getBoundingClientRect")
    .mockReturnValue(domRect(8, 12, 400, 300));
  const clipperRect = vi
    .spyOn(clipper, "getBoundingClientRect")
    .mockReturnValue(domRect(0, 0, 1000, 700));
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
    clipTo(left, top, width, height) {
      clipperRect.mockReturnValue(domRect(left, top, width, height));
    },
    sentBounds,
  };
}

describe("useBrowserViewBoundsBridge", () => {
  beforeEach(() => {
    installFrameStub();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("registers and sends the mount-time rect", () => {
    const harness = renderBridge(true);

    expect(registerMock).toHaveBeenCalledWith({
      key: TILE_KEY,
      rect: {
        left: 8,
        top: 12,
        right: 408,
        bottom: 312,
        width: 400,
        height: 300,
      },
    });
    expect(harness.sentBounds).toHaveLength(1);
    expect(harness.sentBounds[0]).toMatchObject({
      bounds: { x: 8, y: 12, width: 400, height: 300 },
    });
  });

  it("re-sends when the tile MOVES without resizing", () => {
    const harness = renderBridge(true);
    harness.sentBounds.length = 0;

    // No resize, no scroll, no DOM mutation: exactly the pane-animation and
    // equal-pane-move cases that used to leave the native view behind.
    harness.setRect(500, 12, 400, 300);
    act(() => {
      flushFrames();
    });

    expect(harness.sentBounds).toHaveLength(1);
    expect(harness.sentBounds[0]).toMatchObject({
      bounds: { x: 500, y: 12, width: 400, height: 300 },
    });
    expect(updateRectMock).toHaveBeenLastCalledWith(
      TILE_KEY,
      expect.objectContaining({ left: 500 }),
    );
  });

  it("sends nothing while the rect is unchanged", () => {
    const harness = renderBridge(true);
    harness.sentBounds.length = 0;

    act(() => {
      flushFrames();
      flushFrames();
      flushFrames();
    });

    expect(harness.sentBounds).toEqual([]);
  });

  it("forwards sub-pixel movement, which main rounds in DIP space", () => {
    // Rounding here would round in CSS space, before main has multiplied by
    // the window zoom factor - at 125% an x of 8.1 and 8.4 are different DIPs
    // while agreeing on 8 in CSS px, so suppressing the send would strand the
    // native tile. Main coalesces identical DIP rects itself.
    const harness = renderBridge(true);
    harness.sentBounds.length = 0;

    harness.setRect(8.1, 12.2, 399.9, 300.1);
    act(() => {
      flushFrames();
    });

    expect(harness.sentBounds).toHaveLength(1);
    expect(harness.sentBounds[0]?.bounds.x).toBe(8.1);
    expect(harness.sentBounds[0]?.bounds.y).toBe(12.2);
    expect(harness.sentBounds[0]?.bounds.width).toBeCloseTo(399.9, 6);
    expect(harness.sentBounds[0]?.bounds.height).toBeCloseTo(300.1, 6);
  });

  it("reports only the part a clipping ancestor leaves visible", () => {
    const harness = renderBridge(true);
    harness.sentBounds.length = 0;

    harness.clipTo(0, 0, 200, 700);
    act(() => {
      flushFrames();
    });

    expect(harness.sentBounds[0]).toMatchObject({
      bounds: { x: 8, y: 12, width: 192, height: 300 },
    });
  });

  it("reports a zero-area rect once the tile is clipped fully out of its container", () => {
    const harness = renderBridge(true);
    harness.sentBounds.length = 0;

    harness.clipTo(0, 0, 1000, 700);
    harness.setRect(8, 800, 400, 300);
    act(() => {
      flushFrames();
    });

    expect(harness.sentBounds[0]?.bounds).toMatchObject({
      width: 0,
      height: 0,
    });
  });

  it("stops measuring on unmount", () => {
    const harness = renderBridge(true);
    harness.sentBounds.length = 0;

    cleanup();
    harness.setRect(500, 12, 400, 300);
    act(() => {
      flushFrames();
    });

    expect(harness.sentBounds).toEqual([]);
    expect(pendingFrames).toEqual([]);
  });

  it("does not register anything without a desktop bridge", () => {
    renderBridge(false);

    expect(registerMock).not.toHaveBeenCalled();
    expect(pendingFrames).toEqual([]);
  });
});
