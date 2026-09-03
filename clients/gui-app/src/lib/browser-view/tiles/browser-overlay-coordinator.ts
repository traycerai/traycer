import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { browserViewTileKeyId } from "./browser-view-keys";

/** A CSS-pixel rect in viewport coordinates, as `DOMRect` reports them. */
export interface BrowserOverlayRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserOverlayTile {
  readonly key: BrowserViewTileKey;
  readonly keyId: string;
  readonly rect: BrowserOverlayRect;
}

interface BrowserOverlayTileRegistration {
  readonly key: BrowserViewTileKey;
  readonly keyId: string;
  rect: BrowserOverlayRect;
}

const tilesByKeyId = new Map<string, BrowserOverlayTileRegistration>();
const layoutListeners = new Set<() => void>();

export function rectFromDomRect(rect: DOMRectReadOnly): BrowserOverlayRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function registerBrowserOverlayTile(input: {
  readonly key: BrowserViewTileKey;
  readonly rect: BrowserOverlayRect;
}): () => void {
  const keyId = browserViewTileKeyId(input.key);
  tilesByKeyId.set(keyId, {
    key: input.key,
    keyId,
    rect: input.rect,
  });
  emitLayoutChange();
  return () => {
    tilesByKeyId.delete(keyId);
    emitLayoutChange();
  };
}

export function updateBrowserOverlayTileRect(
  key: BrowserViewTileKey,
  rect: BrowserOverlayRect,
): void {
  const keyId = browserViewTileKeyId(key);
  const entry = tilesByKeyId.get(keyId);
  if (entry === undefined) return;
  if (rectsEqual(entry.rect, rect)) return;
  entry.rect = rect;
  emitLayoutChange();
}

export function listBrowserOverlayTiles(): readonly BrowserOverlayTile[] {
  return Array.from(tilesByKeyId.values()).map((entry) => ({
    key: entry.key,
    keyId: entry.keyId,
    rect: entry.rect,
  }));
}

export function subscribeBrowserOverlayLayout(
  listener: () => void,
): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}

export function rectsIntersect(
  first: BrowserOverlayRect,
  second: BrowserOverlayRect,
): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

function rectsEqual(
  first: BrowserOverlayRect,
  second: BrowserOverlayRect,
): boolean {
  return (
    first.left === second.left &&
    first.top === second.top &&
    first.right === second.right &&
    first.bottom === second.bottom &&
    first.width === second.width &&
    first.height === second.height
  );
}

function emitLayoutChange(): void {
  layoutListeners.forEach((listener) => listener());
}
