/** Navigating early to conjure the destination is the obvious alternative and is the one thing this must not
 * do. */

/** Marks the element a snapshot is taken OF - the shell column, so a snapshot carries the header with the
 * content and the two travel as one screen. */
export const SWIPE_NAV_SCREEN_ATTRIBUTE = "data-swipe-nav-screen";

/** Marks a subtree that must never appear inside a snapshot. */
export const SWIPE_NAV_EXCLUDE_ATTRIBUTE = "data-swipe-nav-exclude";

export interface ScreenSnapshotScroll {
  /** The element inside {@link ScreenSnapshot.node}, not the one copied from. */
  readonly element: HTMLElement;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export interface ScreenSnapshot {
  readonly node: HTMLElement;
  /** Carried rather than written into the clone directly, because a detached element has no scroll box. */
  readonly scrollOffsets: ReadonlyArray<ScreenSnapshotScroll>;
}

/** The element a snapshot is taken of, or `null` before the shell has mounted. */
export function findSnapshotSource(): HTMLElement | null {
  const source = document.querySelector(`[${SWIPE_NAV_SCREEN_ATTRIBUTE}]`);
  return source instanceof HTMLElement ? source : null;
}

/** Fidelity is restored by walking the source and the clone as index-aligned lists, which only holds while the
 * two trees are identical. */
export function captureScreenSnapshot(
  source: HTMLElement,
): ScreenSnapshot | null {
  const clone = source.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;
  const scrollOffsets = recordScrollOffsets(source, clone);
  restoreCanvasPixels(source, clone);
  dropExcludedSubtrees(clone);
  // A frozen screen is scenery: it must not answer a hit test, receive focus, or be read out, all of which it
  // would otherwise do while sitting on top of the live app it was copied from.
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.style.pointerEvents = "none";
  return { node: clone, scrollOffsets };
}

/** Without it every scrollable region in the frozen screen sits at its top, so a chat read halfway down freezes
 * as a chat at the beginning, and the transition shows the user a screen they were never on. */
function recordScrollOffsets(
  source: HTMLElement,
  clone: HTMLElement,
): ReadonlyArray<ScreenSnapshotScroll> {
  // The roots lead their own descendant walks: `querySelectorAll` returns descendants only.
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

/** Call once the snapshot's node is IN the document - before that there is nothing to scroll. Filtering for
 * that would mean re-deriving which nodes survived, which is a second copy of the exclusion rule for no gain. */
export function applyScreenSnapshotScroll(snapshot: ScreenSnapshot): void {
  for (const offset of snapshot.scrollOffsets) {
    offset.element.scrollTop = offset.scrollTop;
    offset.element.scrollLeft = offset.scrollLeft;
  }
}

/** A cloned `<canvas>` carries its dimensions and nothing that was drawn into it, so it arrives blank. */
function restoreCanvasPixels(source: HTMLElement, clone: HTMLElement): void {
  const sourceCanvases = source.querySelectorAll("canvas");
  const cloneCanvases = clone.querySelectorAll("canvas");
  for (let index = 0; index < sourceCanvases.length; index += 1) {
    // Index-aligned by construction: the clone is still structurally identical to its source at this point, which
    // is what the ordering above exists to guarantee.
    const from = sourceCanvases[index];
    const to = cloneCanvases[index];
    if (from.width === 0 || from.height === 0) continue;
    const context = to.getContext("2d");
    if (context === null) continue;
    try {
      context.drawImage(from, 0, 0);
    } catch {
      // A canvas the browser considers tainted refuses to be read, and a hardware-accelerated one may have no
      // readable backing store.
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
