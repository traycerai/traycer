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

/** One scrollable region of a frozen screen, and where it was scrolled to. */
export interface ScreenSnapshotScroll {
  /** The element inside {@link ScreenSnapshot.node}, not the one copied from. */
  readonly element: HTMLElement;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export interface ScreenSnapshot {
  /** Detached, inert clone. Mount it by appending; nothing else owns it. */
  readonly node: HTMLElement;
  /**
   * Where each scrollable region was, RECORDED at capture and applied by
   * {@link applyScreenSnapshotScroll} once the node is in the document.
   *
   * Carried rather than written into the clone directly, because a detached
   * element has no scroll box: assigning `scrollTop` to a node outside the
   * document is silently discarded, so the offsets have to survive as data
   * until there is something to apply them to.
   */
  readonly scrollOffsets: ReadonlyArray<ScreenSnapshotScroll>;
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
  const scrollOffsets = recordScrollOffsets(source, clone);
  restoreCanvasPixels(source, clone);
  dropExcludedSubtrees(clone);
  // A frozen screen is scenery: it must not answer a hit test, receive focus,
  // or be read out, all of which it would otherwise do while sitting on top of
  // the live app it was copied from.
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.style.pointerEvents = "none";
  return { node: clone, scrollOffsets };
}

/**
 * Where every scrolled region of the screen was, paired with the clone element
 * that has to be put there.
 *
 * `cloneNode` copies markup, and a scroll offset is not markup - it is live
 * state on the element. Without it every scrollable region in the frozen screen
 * sits at its top, so a chat read halfway down freezes as a chat at the
 * beginning, and the transition shows the user a screen they were never on.
 *
 * The offsets are only READ here. Writing them now would be writing to a
 * detached element, which has no scroll box and silently discards the
 * assignment - the defect this split exists to fix.
 */
function recordScrollOffsets(
  source: HTMLElement,
  clone: HTMLElement,
): ReadonlyArray<ScreenSnapshotScroll> {
  // The roots lead their own descendant walks: `querySelectorAll` returns
  // descendants only, and the screen root is as capable of scrolling as
  // anything inside it - skipping it would freeze exactly the region the
  // marker names at its top.
  const sourceNodes = [source, ...source.querySelectorAll("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll("*")];
  const offsets: ScreenSnapshotScroll[] = [];
  for (let index = 0; index < sourceNodes.length; index += 1) {
    const from = sourceNodes[index];
    const to = cloneNodes[index];
    if (!(to instanceof HTMLElement)) continue;
    if (from.scrollTop === 0 && from.scrollLeft === 0) continue;
    offsets.push({
      element: to,
      scrollTop: from.scrollTop,
      scrollLeft: from.scrollLeft,
    });
  }
  return offsets;
}

/**
 * Puts every recorded region back where it was. Call once the snapshot's node
 * is IN the document - before that there is nothing to scroll.
 *
 * An element dropped with an excluded subtree is still in this list and is
 * still assigned to; it is detached, so the write goes nowhere and costs
 * nothing. Filtering for that would mean re-deriving which nodes survived,
 * which is a second copy of the exclusion rule for no gain.
 */
export function applyScreenSnapshotScroll(snapshot: ScreenSnapshot): void {
  for (const offset of snapshot.scrollOffsets) {
    offset.element.scrollTop = offset.scrollTop;
    offset.element.scrollLeft = offset.scrollLeft;
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
