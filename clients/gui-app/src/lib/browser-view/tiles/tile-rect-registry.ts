import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { browserViewTileKeyId } from "./browser-view-keys";

/** A CSS-pixel rect in viewport coordinates, as `DOMRect` reports them. */
export interface TileRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface TileRegistration {
  readonly element: HTMLElement;
}

const tilesByKeyId = new Map<string, TileRegistration>();
const listeners = new Set<() => void>();

/**
 * Register a tile's surface element. Rects are measured at read time, so a
 * tile that MOVES without resizing is never stale.
 */
export function registerTileRect(
  key: BrowserViewTileKey,
  element: HTMLElement,
): () => void {
  const keyId = browserViewTileKeyId(key);
  const registration: TileRegistration = { element };
  tilesByKeyId.set(keyId, registration);
  notifyTileRects();
  return () => {
    if (tilesByKeyId.get(keyId) !== registration) return;
    tilesByKeyId.delete(keyId);
    notifyTileRects();
  };
}

export function listTileRects(): readonly TileRect[] {
  return Array.from(tilesByKeyId.values(), (entry) => {
    const rect = entry.element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
}

/**
 * Whether a real browser tile is taking up pixels right now (C-18, 4.2, 5.2).
 *
 * A `<webview>` guest is a `position: fixed` child of `document.body` placed
 * by the compositor, so nothing the page does to itself reaches it: the layout
 * editor's `opacity` and `filter` dim leaves it as the one lit thing on a calm
 * canvas, and a view transition glides a snapshot of the shell out from under
 * a tile that never moves. The editor asks this once, for the second of those
 * - whether the entry and the exit animate (`shellTransitionAllowed`). It no
 * longer asks it to pick a canvas: every session opens the sample workspace
 * (L-87).
 *
 * A registration only exists while its tile is `presented`, and a zero-sized
 * surface is a tile with nowhere to paint, so measuring is what separates
 * "registered" from "on screen".
 *
 * Read imperatively and never subscribed: the answer is needed once, at the
 * moment a gesture reaches the door.
 */
export function aNativeTileIsPresented(): boolean {
  return listTileRects().some((rect) => rect.width > 0 && rect.height > 0);
}

export function subscribeTileRects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyTileRects(): void {
  listeners.forEach((listener) => listener());
}

export function rectsIntersect(first: TileRect, second: TileRect): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}
