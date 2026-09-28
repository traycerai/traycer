import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  aNativeTileIsPresented,
  listTileRects,
  notifyTileRects,
  rectsIntersect,
  registerTileRect,
  subscribeTileRects,
  type TileRect,
} from "@/lib/browser-view/tiles/tile-rect-registry";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";

let pendingDeregisters: Array<() => void> = [];

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

const RECT_A: TileRect = {
  left: 0,
  top: 0,
  right: 100,
  bottom: 80,
  width: 100,
  height: 80,
};

const RECT_B: TileRect = {
  left: 40,
  top: 20,
  right: 160,
  bottom: 140,
  width: 120,
  height: 120,
};

/** A tile whose surface has no box: registered, but with nowhere to paint. */
const EMPTY_RECT: TileRect = {
  left: 24,
  top: 24,
  right: 24,
  bottom: 24,
  width: 0,
  height: 0,
};

/** A detached element whose measured rect the test controls. */
function stubRect(element: HTMLElement, rect: TileRect): void {
  element.getBoundingClientRect = () => ({
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
}

function elementAt(rect: TileRect): HTMLElement {
  const element = document.createElement("div");
  stubRect(element, rect);
  return element;
}

function registerTile(
  key: BrowserViewTileKey,
  element: HTMLElement,
): () => void {
  const deregister = registerTileRect(key, element);
  pendingDeregisters.push(deregister);
  return deregister;
}

afterEach(() => {
  pendingDeregisters.forEach((deregister) => deregister());
  pendingDeregisters = [];
});

describe("registerTileRect", () => {
  it("lists a registered tile and drops it on deregister", () => {
    const deregister = registerTile(TILE_KEY, elementAt(RECT_A));

    expect(listTileRects()).toEqual([RECT_A]);

    deregister();

    expect(listTileRects()).toEqual([]);
  });

  it("measures the element at read time, so a tile that moves is never stale", () => {
    const element = elementAt(RECT_A);
    registerTile(TILE_KEY, element);

    stubRect(element, RECT_B);

    expect(listTileRects()).toEqual([RECT_B]);
  });

  it("replaces the element for the same tile key", () => {
    registerTile(TILE_KEY, elementAt(RECT_A));
    registerTile(TILE_KEY, elementAt(RECT_B));

    expect(listTileRects()).toEqual([RECT_B]);
  });

  it("keeps two tiles independently", () => {
    registerTile(TILE_KEY, elementAt(RECT_A));
    registerTile(OTHER_KEY, elementAt(RECT_B));

    expect(listTileRects()).toEqual([RECT_A, RECT_B]);
  });

  it("does not let a superseded registration's disposer drop the live one", () => {
    const stale = registerTile(TILE_KEY, elementAt(RECT_A));
    registerTile(TILE_KEY, elementAt(RECT_B));

    stale();

    expect(listTileRects()).toEqual([RECT_B]);
  });

  it("notifies subscribers on register, deregister, and notifyTileRects", () => {
    const counts: number[] = [];
    const unsubscribe = subscribeTileRects(() => {
      counts.push(listTileRects().length);
    });

    const deregister = registerTile(TILE_KEY, elementAt(RECT_A));
    notifyTileRects();
    deregister();

    expect(counts).toEqual([1, 1, 0]);
    unsubscribe();
  });
});

describe("aNativeTileIsPresented", () => {
  it("is false with nothing registered", () => {
    expect(aNativeTileIsPresented()).toBe(false);
  });

  it("is true while a tile has somewhere to paint", () => {
    const deregister = registerTile(TILE_KEY, elementAt(RECT_A));

    expect(aNativeTileIsPresented()).toBe(true);

    deregister();

    expect(aNativeTileIsPresented()).toBe(false);
  });

  it("ignores a registration with no box, which is a tile that is not on screen", () => {
    registerTile(TILE_KEY, elementAt(EMPTY_RECT));

    expect(listTileRects()).toEqual([EMPTY_RECT]);
    expect(aNativeTileIsPresented()).toBe(false);
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
