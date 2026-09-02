import { useEffect, type RefObject } from "react";
import {
  registerBrowserOverlayTile,
  setBrowserOverlayTileMotion,
  updateBrowserOverlayTileRect,
  type BrowserOverlayRect,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import type {
  BrowserViewBounds,
  BrowserViewBridge,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

// Instant-enter/2-frame-exit hysteresis oscillated on ragged scrolls (wheel
// ticks, flick tails): each re-entry into motion cost a capturePage + park +
// restore race per tile, which reads as flicker. 6 frames (~100ms at 60fps)
// of extra hold at rest costs at most one stale frame in exchange.
// ponytail: still a guess, not a measurement - ticket 09's live probe should
// confirm or retune this against the tail of a real pane animation.
const MOTION_REST_FRAME_THRESHOLD = 6;

interface UseBrowserViewBoundsBridgeArgs {
  readonly browserView: BrowserViewBridge | null;
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly tileKey: BrowserViewTileKey;
  readonly visible: boolean;
}

/**
 * Shared bounds + overlay-registry bridge for every Electron tile.
 * Both user and agent tiles punch through popovers unless the overlay
 * coordinator knows their live rect, so this hook is capability-agnostic.
 *
 * What it reports is the tile's TRUE VISIBLE rect - the surface intersected
 * with the viewport and with every clipping ancestor - in renderer CSS
 * pixels. A scrolled-away tile therefore reports a zero-area rect and the
 * main process hides it, instead of the native view painting over whatever
 * the container's edge was supposed to cut off. The CSS -> window-DIP
 * conversion is the main process's (`BrowserViewGeometry`); this side stays
 * in the space `getBoundingClientRect` speaks.
 *
 * Known ceiling of reporting the visible rect: `setBounds` is placement, not
 * a crop - a WebContentsView has no clip - so a PARTIALLY clipped tile does
 * not show a cropped page, it shows a page laid out for the smaller viewport
 * (and, when the cut is on the left or top, one whose origin moved to the
 * clip edge). The alternative is the unclipped rect, which composites the
 * native view straight over whatever the container's edge was meant to cut
 * off; that spill is the worse of the two, so partial clipping reflows on
 * purpose. Cropping properly needs a real clip primitive, or hiding a tile
 * that is not fully visible.
 *
 * Measurement is one rAF loop while the tile is visible, and it is not a
 * poll for want of a better trigger: a tile moves without resizing and
 * without scrolling (a pane transform animation, a re-parent between
 * equally sized panes), and NO DOM event reports that. ResizeObserver and
 * `resize`/`scroll` listeners each cover a subset; per-frame measurement is
 * the only thing that covers all of them, and it costs one rect read plus a
 * comparison per visible tile - nothing is sent when the rect is unchanged,
 * so an idle tile produces zero IPC. Chromium stops firing rAF entirely
 * while the window is occluded or hidden, which is exactly when the loop
 * has nothing to do.
 *
 * Bounds stream CONTINUOUSLY, including through panel resize drags (BT-102):
 * freezing sends during a drag left the native view at its pre-drag rect
 * compositing over neighboring tiles until pointer-up. The one-frame IPC
 * trail this produces during a drag is the accepted physics of the
 * WebContentsView architecture (ADR 0001 R1); re-tune only if BT-103
 * measurement shows guest relayout jank at display rate.
 */
export function useBrowserViewBoundsBridge(
  args: UseBrowserViewBoundsBridgeArgs,
): void {
  const { browserView, surfaceRef, tileKey, visible } = args;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (browserView === null || surface === null || !visible) return;
    let clipChain = resolveClipChain(surface, null);
    const unregisterOverlayTile = registerBrowserOverlayTile({
      key: tileKey,
      rect: visibleRectOf(surface, clipChain),
    });

    let frameId: number | null = null;
    let lastSentBounds: BrowserViewBounds | null = null;
    // Invariant 8: motion is derived from this SAME per-frame comparison,
    // not a second measurement or a new listener - see the header above for
    // why scroll/resize/animation listeners each miss cases this rAF loop
    // already covers. "Moving" is "the rect changed this frame"; "at rest"
    // is "the rect has been identical for N consecutive frames" (below).
    let inMotion = false;
    let restFrameCount = 0;

    const measure = (): void => {
      frameId = window.requestAnimationFrame(measure);
      clipChain = resolveClipChain(surface, clipChain);
      const rect = visibleRectOf(surface, clipChain);
      // The registry drops identical rects itself, so the overlay
      // coordinator only re-scans when the tile actually moved.
      updateBrowserOverlayTileRect(tileKey, rect);
      const bounds: BrowserViewBounds = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      // Compared EXACTLY, never rounded. Rounding here would be rounding in
      // the wrong space: main converts CSS px to window DIPs by the window's
      // zoom factor before it rounds, so at 125% an x of 8.1 and 8.4 land on
      // different DIPs while agreeing on 8 here - and the suppressed send
      // would leave the native tile permanently short of its final position.
      // Sub-pixel jitter is cheap to forward: main coalesces identical DIP
      // rects itself (`BrowserViewGeometry.applyBounds`), and an idle tile
      // reports byte-identical rects, so it still produces zero IPC.
      const unchangedSinceLastFrame =
        lastSentBounds !== null && boundsAreEqual(lastSentBounds, bounds);
      if (unchangedSinceLastFrame) {
        if (inMotion) {
          restFrameCount += 1;
          if (restFrameCount >= MOTION_REST_FRAME_THRESHOLD) {
            inMotion = false;
            setBrowserOverlayTileMotion(tileKey, false);
          }
        }
        return;
      }
      restFrameCount = 0;
      // The first frame after mount always changes `lastSentBounds` from
      // null - that is the tile appearing, not moving, so it must not flag
      // motion.
      if (lastSentBounds !== null && !inMotion) {
        inMotion = true;
        setBrowserOverlayTileMotion(tileKey, true);
      }
      lastSentBounds = bounds;
      void browserView.updateBounds({ ...tileKey, bounds }).catch(ignoreError);
    };

    measure();

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      unregisterOverlayTile();
    };
  }, [browserView, surfaceRef, tileKey, visible]);
}

/** The part of `element` that is actually on screen, in CSS pixels. */
function visibleRectOf(
  element: HTMLElement,
  clipChain: ClipChain,
): BrowserOverlayRect {
  let rect = intersectRects(
    rectOf(element.getBoundingClientRect()),
    viewportRect(),
  );
  for (const clipper of clipChain.clippers) {
    rect = intersectRects(rect, rectOf(clipper.getBoundingClientRect()));
  }
  return rect;
}

interface ClipChain {
  readonly ancestors: readonly HTMLElement[];
  readonly clippers: readonly HTMLElement[];
}

/**
 * Which ancestors cut the tile off. Style is read only when the ancestor
 * CHAIN changed (mount, or a re-parent), never per frame.
 *
 * Three known ceilings, none of them live for today's tiles - a browser tile
 * is a statically positioned canvas child:
 * - an ancestor that starts or stops clipping without the chain changing
 *   (a toggled `overflow-hidden` class) is not re-resolved;
 * - a `position: fixed` tile is over-clipped by scrolling ancestors that do
 *   not establish its containing block;
 * - `clip-path` / `contain: paint` ancestors clip while still reporting
 *   `overflow: visible`, so they under-clip.
 */
function resolveClipChain(
  element: HTMLElement,
  cached: ClipChain | null,
): ClipChain {
  const ancestors: HTMLElement[] = [];
  for (
    let ancestor = element.parentElement;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    ancestors.push(ancestor);
  }
  if (cached !== null && sameElements(cached.ancestors, ancestors)) {
    return cached;
  }
  return { ancestors, clippers: ancestors.filter(clipsOverflow) };
}

function sameElements(
  first: readonly HTMLElement[],
  second: readonly HTMLElement[],
): boolean {
  return (
    first.length === second.length &&
    first.every((element, index) => element === second[index])
  );
}

function clipsOverflow(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    isClippingOverflow(style.overflowX) || isClippingOverflow(style.overflowY)
  );
}

/** An unreported overflow counts as `visible`: never clip on a guess. */
function isClippingOverflow(overflow: string): boolean {
  return overflow !== "" && overflow !== "visible";
}

function viewportRect(): BrowserOverlayRect {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function rectOf(rect: DOMRectReadOnly): BrowserOverlayRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function intersectRects(
  first: BrowserOverlayRect,
  second: BrowserOverlayRect,
): BrowserOverlayRect {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  // A fully clipped tile collapses to a point rather than an inverted rect,
  // so intersection tests downstream cannot read it as covering anything.
  if (right <= left || bottom <= top) {
    return { left, top, right: left, bottom: top, width: 0, height: 0 };
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function boundsAreEqual(
  first: BrowserViewBounds,
  second: BrowserViewBounds,
): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  );
}
