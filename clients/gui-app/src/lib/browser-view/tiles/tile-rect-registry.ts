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
