import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBrowserOverlayElements,
  listBrowserOverlaySurfaces,
  listBrowserOverlayTiles,
  registerBrowserOverlay as registerBrowserOverlayDirect,
  registerBrowserOverlayTile as registerBrowserOverlayTileDirect,
  resolveBrowserOverlayMotionTargets,
  resolveBrowserOverlayOcclusionTargets,
  setBrowserOverlayTileMotion,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";

// Registry map hygiene: every registration made through `registerBrowserOverlay`
// or `registerBrowserOverlayTile` below is tracked and deregistered here, so a
// test that never calls its own deregister thunk - an `expect` that throws
// before the last statement is enough - cannot leak a stale entry into the
// next test's `overlaysById` / `tilesByKeyId` map (the registry is
// module-level state, not reset per test). Deregistering twice is a no-op, so
// a test that does call its own thunk stays correct.
let pendingDeregisters: Array<() => void> = [];
function registerBrowserOverlay(
  input: Parameters<typeof registerBrowserOverlayDirect>[0],
): () => void {
  const deregister = registerBrowserOverlayDirect(input);
  pendingDeregisters.push(deregister);
  return deregister;
}

function registerBrowserOverlayTile(
  input: Parameters<typeof registerBrowserOverlayTileDirect>[0],
): () => void {
  const deregister = registerBrowserOverlayTileDirect(input);
  pendingDeregisters.push(deregister);
  return deregister;
}

afterEach(() => {
  pendingDeregisters.forEach((deregister) => deregister());
  pendingDeregisters = [];
  document.body.replaceChildren();
});

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

const FULL_TILE_RECT = {
  left: 0,
  top: 0,
  right: 100,
  bottom: 100,
  width: 100,
  height: 100,
};

function appendElement(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
  document.body.append(element);
  return element;
}

const FULL_RECT = { left: 0, top: 0, width: 100, height: 100 };

describe("isElementVisible (via listBrowserOverlaySurfaces)", () => {
  it("skips a `hidden` element", () => {
    const element = appendElement(FULL_RECT);
    element.hidden = true;
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it('skips a `data-state="closed"` element', () => {
    const element = appendElement(FULL_RECT);
    element.setAttribute("data-state", "closed");
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it("skips a `display: none` element", () => {
    const element = appendElement(FULL_RECT);
    element.style.display = "none";
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it("skips a `visibility: hidden` element", () => {
    const element = appendElement(FULL_RECT);
    element.style.visibility = "hidden";
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it("skips an `opacity: 0` element with no running animation (steady-state hidden)", () => {
    const element = appendElement(FULL_RECT);
    element.style.opacity = "0";
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it("still detects an `opacity: 0` element mid fade-in (a running Animation)", () => {
    const element = appendElement(FULL_RECT);
    element.style.opacity = "0";
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => [{} as Animation],
    });
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toHaveLength(1);
  });

  it("does not throw when getAnimations is entirely unavailable (jsdom-safe guard)", () => {
    const element = appendElement(FULL_RECT);
    element.style.opacity = "0";
    expect("getAnimations" in element).toBe(false);
    registerBrowserOverlay({ element });

    expect(() => listBrowserOverlaySurfaces()).not.toThrow();
    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it("detects a fully opaque, unhidden element", () => {
    const element = appendElement(FULL_RECT);
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toHaveLength(1);
  });

  // The surgical fix's regression pin, now expressed against the registry
  // directly: aria-hidden is an assistive-tech signal, never a paint signal
  // (invariant 3), and must never re-enter the predicate.
  it('does NOT hide an element whose only signal is aria-hidden="true"', () => {
    const element = appendElement(FULL_RECT);
    element.setAttribute("aria-hidden", "true");
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toHaveLength(1);
  });
});

describe("registerBrowserOverlay", () => {
  it("registers and deregisters", () => {
    const element = appendElement(FULL_RECT);
    const deregister = registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toHaveLength(1);

    deregister();

    expect(listBrowserOverlaySurfaces()).toEqual([]);
  });

  it("stops occluding once deregistered", () => {
    const unregisterTile = registerBrowserOverlayTile({
      key: TILE_KEY,
      rect: FULL_TILE_RECT,
    });
    const element = appendElement(FULL_RECT);
    const deregister = registerBrowserOverlay({ element });

    expect(
      resolveBrowserOverlayOcclusionTargets(
        listBrowserOverlaySurfaces(),
        listBrowserOverlayTiles(),
      ),
    ).toHaveLength(1);

    deregister();

    expect(
      resolveBrowserOverlayOcclusionTargets(
        listBrowserOverlaySurfaces(),
        listBrowserOverlayTiles(),
      ),
    ).toEqual([]);

    unregisterTile();
  });

  it("drops an overlay whose element left the document without deregistering", () => {
    const element = appendElement(FULL_RECT);
    registerBrowserOverlay({ element });

    expect(listBrowserOverlaySurfaces()).toHaveLength(1);

    element.remove();

    expect(listBrowserOverlaySurfaces()).toEqual([]);
    // The registration itself is not force-evicted on disconnect (a
    // `SelectContent` steady-state parks its content in a detached
    // `DocumentFragment` between opens without ever unmounting) - only
    // excluded from the painted surfaces list while disconnected. The
    // MutationObserver target list still needs to see it so a later
    // reconnect + `data-state` flip is what tells the bridge to rescan.
    expect(listBrowserOverlayElements()).toContain(element);
  });

  it("keeps two overlays over the same tile both occluding it", () => {
    const unregisterTile = registerBrowserOverlayTile({
      key: TILE_KEY,
      rect: FULL_TILE_RECT,
    });
    const first = appendElement({ left: 0, top: 0, width: 40, height: 40 });
    const second = appendElement({ left: 10, top: 10, width: 40, height: 40 });
    registerBrowserOverlay({ element: first });
    registerBrowserOverlay({ element: second });

    const targets = resolveBrowserOverlayOcclusionTargets(
      listBrowserOverlaySurfaces(),
      listBrowserOverlayTiles(),
    );

    expect(targets).toHaveLength(2);
    expect(targets.every((target) => target.tiles[0] === TILE_KEY)).toBe(true);

    unregisterTile();
  });
});

// Invariant 8: motion (canvas scroll / pane animation / resize) is a second
// freeze input to the same state machine, reported by
// `setBrowserOverlayTileMotion` (the bounds-bridge rAF loop calls it - see
// `use-browser-view-bounds-bridge.test.ts` for that side) and resolved into
// a synthetic per-tile owner here, never through
// `resolveBrowserOverlayOcclusionTargets` (there is no overlay rect to
// intersect for a motion owner).
describe("resolveBrowserOverlayMotionTargets", () => {
  it("produces nothing for a tile that is not moving", () => {
    const unregisterTile = registerBrowserOverlayTile({
      key: TILE_KEY,
      rect: FULL_TILE_RECT,
    });

    expect(
      resolveBrowserOverlayMotionTargets(listBrowserOverlayTiles()),
    ).toEqual([]);

    unregisterTile();
  });

  it("produces a synthetic owner target for a moving tile, distinct from an overlay owner", () => {
    const unregisterTile = registerBrowserOverlayTile({
      key: TILE_KEY,
      rect: FULL_TILE_RECT,
    });

    setBrowserOverlayTileMotion(TILE_KEY, true);
    const targets = resolveBrowserOverlayMotionTargets(
      listBrowserOverlayTiles(),
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.tiles).toEqual([TILE_KEY]);
    // Opaque but stable per tile, not per overlay id space, so the bridge's
    // per-owner occlude/release latch tracks it across scans the same way it
    // tracks an overlay owner.
    expect(targets[0]?.overlayId).not.toMatch(/^browser-overlay-\d/);

    setBrowserOverlayTileMotion(TILE_KEY, false);
    expect(
      resolveBrowserOverlayMotionTargets(listBrowserOverlayTiles()),
    ).toEqual([]);

    unregisterTile();
  });

  it("is a no-op for an unregistered tile key", () => {
    // No tile registered at all - setBrowserOverlayTileMotion must not
    // throw or create a phantom registration.
    expect(() => setBrowserOverlayTileMotion(TILE_KEY, true)).not.toThrow();
    expect(listBrowserOverlayTiles()).toEqual([]);
  });

  it("composes a motion owner with an overlay owner covering the same tile", () => {
    const unregisterTile = registerBrowserOverlayTile({
      key: TILE_KEY,
      rect: FULL_TILE_RECT,
    });
    const element = appendElement(FULL_RECT);
    registerBrowserOverlay({ element });
    setBrowserOverlayTileMotion(TILE_KEY, true);

    const tiles = listBrowserOverlayTiles();
    const overlayTargets = resolveBrowserOverlayOcclusionTargets(
      listBrowserOverlaySurfaces(),
      tiles,
    );
    const motionTargets = resolveBrowserOverlayMotionTargets(tiles);

    expect(overlayTargets).toHaveLength(1);
    expect(motionTargets).toHaveLength(1);
    // Two independent owners over the same tile: neither is derived from
    // the other, so releasing one (overlay closes, or motion rests) leaves
    // the other's ownership signature untouched.
    expect(motionTargets[0]?.overlayId).not.toBe(overlayTargets[0]?.overlayId);

    setBrowserOverlayTileMotion(TILE_KEY, false);
    unregisterTile();
  });
});
