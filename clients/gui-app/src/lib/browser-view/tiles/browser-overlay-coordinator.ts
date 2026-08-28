import type {
  BrowserViewOverlaySnapshot,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { browserViewTileKeyId } from "./browser-view-keys";

export const BROWSER_VIEW_SURFACE_ATTRIBUTE = "data-browser-view-surface";

const BROWSER_OVERLAY_ATTRIBUTE = "data-browser-overlay";
const BROWSER_OVERLAY_ID_ATTRIBUTE = "data-browser-overlay-id";
const BROWSER_OVERLAY_IGNORE_ATTRIBUTE = "data-browser-overlay-ignore";

interface BrowserOverlayRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserOverlaySurface {
  readonly id: string;
  readonly kind: string;
  readonly rect: BrowserOverlayRect;
}

interface BrowserOverlayTile {
  readonly key: BrowserViewTileKey;
  readonly keyId: string;
  readonly rect: BrowserOverlayRect;
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
}

const overlayIdsByElement = new WeakMap<Element, string>();
let nextOverlayId = 1;

const tilesByKeyId = new Map<string, BrowserOverlayTileRegistration>();
const snapshotsByKeyId = new Map<string, BrowserViewSnapshotState>();
const layoutListeners = new Set<() => void>();
const snapshotListenersByKeyId = new Map<string, Set<() => void>>();
const BROWSER_OVERLAY_SELECTORS = [
  `[${BROWSER_OVERLAY_ATTRIBUTE}]`,
  '[data-slot="dialog-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="hover-card-content"]',
  '[data-slot="select-content"]',
  '[data-slot="tooltip-content"]',
  "[data-sonner-toaster]",
  '[role="dialog"]',
].join(",");

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

export function collectBrowserOverlaySurfaces(
  root: ParentNode,
): readonly BrowserOverlaySurface[] {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>(BROWSER_OVERLAY_SELECTORS),
  );
  return Array.from(new Set(elements)).flatMap(
    (element): BrowserOverlaySurface[] => {
      if (element.hasAttribute(BROWSER_OVERLAY_IGNORE_ATTRIBUTE)) return [];
      if (element.closest(`[${BROWSER_OVERLAY_IGNORE_ATTRIBUTE}]`) !== null) {
        return [];
      }
      if (!isElementVisible(element)) return [];
      const rect = rectFromDomRect(element.getBoundingClientRect());
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [
        {
          id: resolveOverlayElementId(element),
          kind: readOverlayKind(element),
          rect,
        },
      ];
    },
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

function rectsIntersect(
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

function resolveOverlayElementId(element: HTMLElement): string {
  const explicitId = element.getAttribute(BROWSER_OVERLAY_ID_ATTRIBUTE);
  if (explicitId !== null && explicitId.length > 0) return explicitId;
  const existingId = overlayIdsByElement.get(element);
  if (existingId !== undefined) return existingId;
  const generatedId = `browser-overlay-${nextOverlayId}`;
  nextOverlayId += 1;
  overlayIdsByElement.set(element, generatedId);
  return generatedId;
}

function readOverlayKind(element: HTMLElement): string {
  const explicitKind = element.getAttribute(BROWSER_OVERLAY_ATTRIBUTE);
  if (explicitKind !== null && explicitKind.length > 0) return explicitKind;
  const slot = element.getAttribute("data-slot");
  if (slot !== null && slot.length > 0) return slot;
  if (element.hasAttribute("data-sonner-toaster")) return "toast";
  const role = element.getAttribute("role");
  if (role !== null && role.length > 0) return role;
  return "overlay";
}

function isElementVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
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
