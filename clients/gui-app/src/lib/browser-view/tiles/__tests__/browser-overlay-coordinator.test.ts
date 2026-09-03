import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBrowserOverlayTiles,
  rectFromDomRect,
  rectsIntersect,
  registerBrowserOverlayTile,
  subscribeBrowserOverlayLayout,
  updateBrowserOverlayTileRect,
  type BrowserOverlayRect,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { browserViewTileKeyId } from "@/lib/browser-view/tiles/browser-view-keys";

let pendingDeregisters: Array<() => void> = [];

function registerTile(input: {
  readonly key: BrowserViewTileKey;
  readonly rect: BrowserOverlayRect;
}): () => void {
  const deregister = registerBrowserOverlayTile(input);
  pendingDeregisters.push(deregister);
  return deregister;
}

afterEach(() => {
  pendingDeregisters.forEach((deregister) => deregister());
  pendingDeregisters = [];
});

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

const OTHER_KEY: BrowserViewTileKey = {
  ...TILE_KEY,
  tileInstanceId: "tile-2",
};

const RECT_A: BrowserOverlayRect = {
  left: 0,
  top: 0,
  right: 100,
  bottom: 80,
  width: 100,
  height: 80,
};

const RECT_B: BrowserOverlayRect = {
  left: 40,
  top: 20,
  right: 160,
  bottom: 140,
  width: 120,
  height: 120,
};

describe("registerBrowserOverlayTile", () => {
  it("lists a registered tile and drops it on deregister", () => {
    const deregister = registerTile({ key: TILE_KEY, rect: RECT_A });

    expect(listBrowserOverlayTiles()).toEqual([
      {
        key: TILE_KEY,
        keyId: browserViewTileKeyId(TILE_KEY),
        rect: RECT_A,
      },
    ]);

    deregister();

    expect(listBrowserOverlayTiles()).toEqual([]);
  });

  it("replaces the rect for the same tile key", () => {
    registerTile({ key: TILE_KEY, rect: RECT_A });
    registerTile({ key: TILE_KEY, rect: RECT_B });

    expect(listBrowserOverlayTiles()).toEqual([
      {
        key: TILE_KEY,
        keyId: browserViewTileKeyId(TILE_KEY),
        rect: RECT_B,
      },
    ]);
  });

  it("keeps two tiles independently", () => {
    registerTile({ key: TILE_KEY, rect: RECT_A });
    registerTile({ key: OTHER_KEY, rect: RECT_B });

    expect(listBrowserOverlayTiles()).toHaveLength(2);
    expect(listBrowserOverlayTiles().map((tile) => tile.key)).toEqual([
      TILE_KEY,
      OTHER_KEY,
    ]);
  });
});

describe("updateBrowserOverlayTileRect", () => {
  it("updates a registered tile and notifies layout listeners", () => {
    const layouts: number[] = [];
    const unsubscribe = subscribeBrowserOverlayLayout(() => {
      layouts.push(listBrowserOverlayTiles().length);
    });
    registerTile({ key: TILE_KEY, rect: RECT_A });
    expect(layouts).toEqual([1]);

    updateBrowserOverlayTileRect(TILE_KEY, RECT_B);
    expect(listBrowserOverlayTiles()[0]?.rect).toEqual(RECT_B);
    expect(layouts).toEqual([1, 1]);

    updateBrowserOverlayTileRect(TILE_KEY, RECT_B);
    expect(layouts).toEqual([1, 1]);

    unsubscribe();
  });

  it("is a no-op for an unregistered tile key", () => {
    const layouts: number[] = [];
    const unsubscribe = subscribeBrowserOverlayLayout(() => {
      layouts.push(1);
    });

    updateBrowserOverlayTileRect(TILE_KEY, RECT_A);

    expect(listBrowserOverlayTiles()).toEqual([]);
    expect(layouts).toEqual([]);
    unsubscribe();
  });
});

describe("rectsIntersect", () => {
  it("detects overlap, edge-touch, and disjoint rects", () => {
    expect(rectsIntersect(RECT_A, RECT_B)).toBe(true);
    expect(
      rectsIntersect(RECT_A, {
        left: 100,
        top: 0,
        right: 140,
        bottom: 80,
        width: 40,
        height: 80,
      }),
    ).toBe(false);
    expect(
      rectsIntersect(RECT_A, {
        left: 200,
        top: 200,
        right: 240,
        bottom: 240,
        width: 40,
        height: 40,
      }),
    ).toBe(false);
  });
});

describe("rectFromDomRect", () => {
  it("copies a DOMRectReadOnly into the overlay rect shape", () => {
    expect(
      rectFromDomRect({
        left: 8,
        top: 12,
        right: 48,
        bottom: 52,
        width: 40,
        height: 40,
        x: 8,
        y: 12,
        toJSON: () => ({}),
      }),
    ).toEqual({
      left: 8,
      top: 12,
      right: 48,
      bottom: 52,
      width: 40,
      height: 40,
    });
  });
});
