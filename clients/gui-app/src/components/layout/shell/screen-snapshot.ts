/**
 * A frozen copy of the app screen, taken so a gesture can move a screen the app
 * is no longer rendering.
 *
 * WHY A COPY AT ALL. A follow-the-finger back gesture has to show two screens
 * at once, and this app can only render one: the router holds a single
 * location, and the phone's epic surface mounts exactly ONE tile
 * (`MobileEpicTileView`), remounting its body when the tile changes. So the
 * screen a back swipe is leaving stops existing the moment the navigation
 * lands, and the screen it is heading to does not exist until then. Neither can
 * be borrowed live.
 *
 * Navigating early to conjure the destination is the obvious alternative and is
 * the one thing this must not do: a swipe the user abandons would have
 * remounted the screen they stayed on, losing its scroll position for a gesture
 * that expressed nothing. A cancelled gesture has to cost exactly nothing, so
 * the app is never navigated until the release commits, and both planes on
 * screen during the drag are copies.
 *
 * The copy is a detached DOM clone rather than a raster. The web has no cheap
 * screen raster, and a clone is one structural copy the browser makes in native
 * code, styled by the same stylesheet it came from - so it needs no measurement
 * pass, no layout of its own, and no second rendering path to keep in step with
 * the real one.
 */

/**
 * Marks the element a snapshot is taken OF - the shell column, so a snapshot
 * carries the header with the content and the two travel as one screen.
 */
export const SWIPE_NAV_SCREEN_ATTRIBUTE = "data-swipe-nav-screen";

/**
 * Marks a subtree that must never appear inside a snapshot. The transition's
 * own layers carry it: a snapshot taken while they are on screen would
 * otherwise clone the frozen screens into the next frozen screen, once per
 * gesture, forever.
 */
export const SWIPE_NAV_EXCLUDE_ATTRIBUTE = "data-swipe-nav-exclude";

export interface ScreenSnapshot {
  /** Detached, inert clone. Mount it by appending; nothing else owns it. */
  readonly node: HTMLElement;
}

/** The element a snapshot is taken of, or `null` before the shell has mounted. */
export function findSnapshotSource(): HTMLElement | null {
  const source = document.querySelector(`[${SWIPE_NAV_SCREEN_ATTRIBUTE}]`);
  return source instanceof HTMLElement ? source : null;
}

/**
 * Freezes the screen as it is painted right now.
 *
 * THE ORDER IS THE CONTRACT. Fidelity is restored by walking the source and the
 * clone as index-aligned lists, which only holds while the two trees are
 * identical - so every copy pass runs BEFORE anything is removed from the
 * clone, and the exclusions are applied last.
 */
export function captureScreenSnapshot(
  source: HTMLElement,
): ScreenSnapshot | null {
  const clone = source.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;
  restoreScrollOffsets(source, clone);
  restoreCanvasPixels(source, clone);
  dropExcludedSubtrees(clone);
  // A frozen screen is scenery: it must not answer a hit test, receive focus,
  // or be read out, all of which it would otherwise do while sitting on top of
  // the live app it was copied from.
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.style.pointerEvents = "none";
  return { node: clone };
}

/**
 * `cloneNode` copies markup, and a scroll offset is not markup - it is live
 * state on the element. Without this every scrollable region in the frozen
 * screen snaps to its top, so a chat read halfway down freezes as a chat at the
 * beginning, and the transition shows the user a screen they were never on.
 */
function restoreScrollOffsets(source: HTMLElement, clone: HTMLElement): void {
  const sourceNodes = source.querySelectorAll("*");
  const cloneNodes = clone.querySelectorAll("*");
  for (let index = 0; index < sourceNodes.length; index += 1) {
    const from = sourceNodes[index];
    const to = cloneNodes[index];
    if (!(to instanceof HTMLElement)) continue;
    if (from.scrollTop === 0 && from.scrollLeft === 0) continue;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
  }
}

/**
 * A cloned `<canvas>` carries its dimensions and nothing that was drawn into
 * it, so it arrives blank. The terminal is the case that matters: xterm paints
 * into canvases, so an unrestored snapshot freezes every terminal tile as an
 * empty black rectangle - the one surface where the copy would be obviously,
 * embarrassingly wrong.
 */
function restoreCanvasPixels(source: HTMLElement, clone: HTMLElement): void {
  const sourceCanvases = source.querySelectorAll("canvas");
  const cloneCanvases = clone.querySelectorAll("canvas");
  for (let index = 0; index < sourceCanvases.length; index += 1) {
    // Index-aligned by construction: the clone is still structurally identical
    // to its source at this point, which is what the ordering above exists to
    // guarantee.
    const from = sourceCanvases[index];
    const to = cloneCanvases[index];
    if (from.width === 0 || from.height === 0) continue;
    const context = to.getContext("2d");
    if (context === null) continue;
    try {
      context.drawImage(from, 0, 0);
    } catch {
      // A canvas the browser considers tainted refuses to be read, and a
      // hardware-accelerated one may have no readable backing store. Neither is
      // recoverable and neither is a reason to abandon the gesture: that one
      // rectangle freezes blank and the rest of the screen is still true.
    }
  }
}

function dropExcludedSubtrees(clone: HTMLElement): void {
  for (const excluded of clone.querySelectorAll(
    `[${SWIPE_NAV_EXCLUDE_ATTRIBUTE}]`,
  )) {
    excluded.remove();
  }
}
