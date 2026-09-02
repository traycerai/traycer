import type {
  BrowserViewOverlaySnapshot,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { browserViewTileKeyId } from "./browser-view-keys";

export const BROWSER_VIEW_SURFACE_ATTRIBUTE = "data-browser-view-surface";

/** A CSS-pixel rect in viewport coordinates, as `DOMRect` reports them. */
export interface BrowserOverlayRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserOverlaySurface {
  readonly id: string;
  readonly rect: BrowserOverlayRect;
}

interface BrowserOverlayTile {
  readonly key: BrowserViewTileKey;
  readonly keyId: string;
  readonly rect: BrowserOverlayRect;
  readonly moving: boolean;
}

interface BrowserOverlayOcclusionTarget {
  readonly overlayId: string;
  readonly tiles: readonly BrowserViewTileKey[];
  readonly signature: string;
}

export type BrowserViewSnapshotState = Omit<
  BrowserViewOverlaySnapshot,
  keyof BrowserViewTileKey
>;

interface BrowserOverlayTileRegistration {
  readonly key: BrowserViewTileKey;
  readonly keyId: string;
  rect: BrowserOverlayRect;
  moving: boolean;
}

interface BrowserOverlayRegistration {
  readonly id: string;
  readonly element: HTMLElement;
}

let nextOverlayId = 1;

const tilesByKeyId = new Map<string, BrowserOverlayTileRegistration>();
const overlaysById = new Map<string, BrowserOverlayRegistration>();
const snapshotsByKeyId = new Map<string, BrowserViewSnapshotState>();
const layoutListeners = new Set<() => void>();
const snapshotListenersByKeyId = new Map<string, Set<() => void>>();

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
    moving: false,
  });
  emitLayoutChange();
  return () => {
    tilesByKeyId.delete(keyId);
    snapshotsByKeyId.delete(keyId);
    emitSnapshotChange(keyId);
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
    moving: entry.moving,
  }));
}

/**
 * Invariant 8: motion (canvas scroll / pane animation / resize) is a second
 * freeze input on the SAME tile, reported by the bounds-bridge rAF loop
 * (`useBrowserViewBoundsBridge`) - never a new listener here. Level-triggered
 * like the rect itself: idempotent, and a no-op re-report emits nothing so a
 * steady-state moving tile does not re-trigger the bridge's scan every frame.
 */
export function setBrowserOverlayTileMotion(
  key: BrowserViewTileKey,
  moving: boolean,
): void {
  const keyId = browserViewTileKeyId(key);
  const entry = tilesByKeyId.get(keyId);
  if (entry === undefined) return;
  if (entry.moving === moving) return;
  entry.moving = moving;
  emitLayoutChange();
}

export function subscribeBrowserOverlayLayout(
  listener: () => void,
): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}

export function setBrowserViewSnapshot(
  snapshot: BrowserViewOverlaySnapshot,
): void {
  const keyId = browserViewTileKeyId(snapshot);
  snapshotsByKeyId.set(keyId, {
    dataUrl: snapshot.dataUrl,
    stale: snapshot.stale,
  });
  emitSnapshotChange(keyId);
}

export function markBrowserViewSnapshotStale(key: BrowserViewTileKey): void {
  const keyId = browserViewTileKeyId(key);
  const snapshot = snapshotsByKeyId.get(keyId);
  if (snapshot === undefined) return;
  snapshotsByKeyId.set(keyId, { ...snapshot, stale: true });
  emitSnapshotChange(keyId);
}

export function clearBrowserViewSnapshot(key: BrowserViewTileKey): void {
  const keyId = browserViewTileKeyId(key);
  if (!snapshotsByKeyId.delete(keyId)) return;
  emitSnapshotChange(keyId);
}

export function getBrowserViewSnapshot(
  key: BrowserViewTileKey,
): BrowserViewSnapshotState | null {
  return snapshotsByKeyId.get(browserViewTileKeyId(key)) ?? null;
}

export function subscribeBrowserViewSnapshot(
  key: BrowserViewTileKey,
  listener: () => void,
): () => void {
  const keyId = browserViewTileKeyId(key);
  const listeners =
    snapshotListenersByKeyId.get(keyId) ?? new Set<() => void>();
  listeners.add(listener);
  snapshotListenersByKeyId.set(keyId, listeners);
  return () => {
    const current = snapshotListenersByKeyId.get(keyId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) snapshotListenersByKeyId.delete(keyId);
  };
}

/**
 * Registers `element` as a live occlusion surface for as long as the caller
 * holds the returned deregister thunk - mounting any wrapped overlay
 * primitive registers a rect, unmount deregisters it. This is the entire
 * discovery mechanism: no CSS-selector scan, no ignore-attribute escape
 * hatch. Not registering IS the escape hatch.
 */
export function registerBrowserOverlay(input: {
  readonly element: HTMLElement;
}): () => void {
  const id = `browser-overlay-${nextOverlayId}`;
  nextOverlayId += 1;
  overlaysById.set(id, { id, element: input.element });
  emitLayoutChange();
  return () => {
    overlaysById.delete(id);
    emitLayoutChange();
  };
}

/**
 * The currently painted overlay surfaces, rect read live off each
 * registered element rather than pushed on every frame. Visibility is the
 * paint-signal predicate (`isElementVisible`) applied to registered
 * elements only - never a DOM-wide scan.
 *
 * A disconnected element (left the document without its owner calling the
 * deregister thunk) is dropped here rather than surfacing as a stale
 * surface forever - but only from THIS list, not from the registry itself.
 * Retention-on-disconnect is a plain safety net, not a requirement of any
 * specific primitive: Radix's `SelectContent`, for instance, swaps
 * `SelectContentImpl` for `SelectContentFragment` (and back) across
 * open/close and re-fires the ref each time, so the ref callback itself
 * deregisters the old element and registers the new one - the registry
 * never actually holds a stale element across that swap. What retention
 * guards against is the general case: any element that goes transiently
 * disconnected (parked in a detached `DocumentFragment`, moved during a
 * portal reparent, etc.) without its owner's ref callback re-firing.
 * Deleting the registration there would drop it for good the moment it
 * reconnects.
 */
export function listBrowserOverlaySurfaces(): readonly BrowserOverlaySurface[] {
  return Array.from(overlaysById.values()).flatMap(
    (registration): BrowserOverlaySurface[] => {
      if (!registration.element.isConnected) return [];
      if (!isElementVisible(registration.element)) return [];
      const rect = rectFromDomRect(
        registration.element.getBoundingClientRect(),
      );
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [{ id: registration.id, rect }];
    },
  );
}

/**
 * The raw registered elements, connected or not - what the bridge's
 * `MutationObserver` needs to watch. Observing a disconnected node is not
 * wasted: `MutationObserver.observe` tracks the node reference itself, so a
 * transiently-disconnected element's state change is still what tells the
 * bridge to rescan once it reconnects (see `listBrowserOverlaySurfaces` for
 * why the registry never deletes on disconnect).
 */
export function listBrowserOverlayElements(): readonly HTMLElement[] {
  return Array.from(
    overlaysById.values(),
    (registration) => registration.element,
  );
}

export function resolveBrowserOverlayOcclusionTargets(
  overlays: readonly BrowserOverlaySurface[],
  tiles: readonly BrowserOverlayTile[],
): readonly BrowserOverlayOcclusionTarget[] {
  return overlays.flatMap((overlay): BrowserOverlayOcclusionTarget[] => {
    const matchedTiles = tiles
      .filter((tile) => rectsIntersect(overlay.rect, tile.rect))
      .map((tile) => tile.key);
    if (matchedTiles.length === 0) return [];
    return [
      {
        overlayId: overlay.id,
        tiles: matchedTiles,
        signature: matchedTiles.map(browserViewTileKeyId).join("|"),
      },
    ];
  });
}

const MOTION_OWNER_PREFIX = "browser-overlay-motion:";

/**
 * A moving tile's freeze target - a synthetic owner keyed to the tile
 * itself, not to any overlay rect. It never goes through
 * `resolveBrowserOverlayOcclusionTargets` (there is no overlay rect to
 * intersect): the state machine's question is still "is this tile frozen",
 * now answered by "some registered rect intersects it OR it is in motion".
 * The overlayId is stable per tile (not per motion episode) so the bridge's
 * `activeSignaturesByOverlayId` latch composes across scans exactly like an
 * overlay owner does, and a tile that is both moving and overlay-covered
 * gets two independent owners - releasing one leaves the other parked.
 */
export function resolveBrowserOverlayMotionTargets(
  tiles: readonly BrowserOverlayTile[],
): readonly BrowserOverlayOcclusionTarget[] {
  return tiles
    .filter((tile) => tile.moving)
    .map((tile) => ({
      overlayId: `${MOTION_OWNER_PREFIX}${tile.keyId}`,
      tiles: [tile.key],
      signature: "moving",
    }));
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

function isElementVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  if (element.getAttribute("data-state") === "closed") return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity !== "0") return true;
  // A fade-in (e.g. Radix `data-open:animate-in fade-in-0`) starts at
  // opacity 0 and produces no further DOM mutation once mounted, so a scan
  // that lands during the fade would otherwise skip the overlay here and
  // never rescan - a permanent occlusion miss on an otherwise DOM-quiet
  // screen. A still-running animation counts as visible so occlusion
  // engages immediately, not after the fade completes.
  return (
    typeof element.getAnimations === "function" &&
    element.getAnimations().length > 0
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

function emitSnapshotChange(keyId: string): void {
  snapshotListenersByKeyId.get(keyId)?.forEach((listener) => listener());
}
