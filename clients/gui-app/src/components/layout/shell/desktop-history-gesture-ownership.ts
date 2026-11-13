import { blockingLayerClaimed } from "./blocking-layer-claim";

/**
 * Route-backed overlays are part of history, and a hover card is a glance at
 * something, so both are marked `allowed`; decision dialogs and menus are not.
 */
export function desktopHistoryLayerBlocksNavigation(): boolean {
  if (blockingLayerClaimed()) return true;
  const layers = document.querySelectorAll(
    // Inline search results also use listbox; only popup listboxes block.
    '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="select-content"][role="listbox"], [data-radix-popper-content-wrapper] [role="listbox"], dialog[open]',
  );
  let routeSurface = false;
  for (const layer of layers) {
    if (
      layer.getAttribute("data-state") === "closed" ||
      layer.closest('[hidden], [inert], [aria-hidden="true"]') !== null
    )
      continue;
    if (layer.getAttribute("data-history-navigation-surface") !== "allowed")
      return true;
    // A nested modal menu disables pointer events on the underlying dialog.
    if (window.getComputedStyle(layer).pointerEvents === "none") return true;
    routeSurface = true;
  }
  return document.body.style.pointerEvents === "none" && !routeSurface;
}

/** Which navigation directions the content under the pointer keeps for itself. */
export interface DesktopHorizontalWheelOwnership {
  readonly back: boolean;
  readonly forward: boolean;
}

/** The `data-history-gesture-owner` value for a surface that owns swipes only sometimes. */
export function historyGestureOwnerAttribute(owns: boolean): "" | undefined {
  return owns ? "" : undefined;
}

export function ownershipUnion(
  a: DesktopHorizontalWheelOwnership,
  b: DesktopHorizontalWheelOwnership,
): DesktopHorizontalWheelOwnership {
  return { back: a.back || b.back, forward: a.forward || b.forward };
}

/**
 * Read at a sequence's opening wheel tick, before any content has moved: a
 * scroller with room in a direction owns that direction for the whole
 * sequence, so a scroll that reaches its edge never turns into navigation,
 * while a fresh sequence starting at that edge may navigate.
 */
export function readDesktopHorizontalWheelOwnership(
  target: EventTarget | null,
): DesktopHorizontalWheelOwnership {
  let back = false;
  let forward = false;
  let node = target instanceof Element ? target : null;
  while (node !== null) {
    if (
      node.matches("[data-history-gesture-owner], .react-flow, webview, iframe")
    )
      return { back: true, forward: true };
    const room = node.scrollWidth - node.clientWidth;
    if (room > 1) {
      // Editing an overflowing text field must not turn into navigation at
      // either end of its value.
      if (node instanceof HTMLInputElement)
        return { back: true, forward: true };
      const style = window.getComputedStyle(node);
      // A horizontally scrollable document scrolls the viewport, and its
      // scrolling element commonly computes `overflow-x: visible`.
      const scrolls =
        node === node.ownerDocument.scrollingElement ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll";
      if (scrolls) {
        const min = style.direction === "rtl" ? -room : 0;
        const max = style.direction === "rtl" ? 0 : room;
        back ||= node.scrollLeft > min + 1;
        forward ||= node.scrollLeft < max - 1;
      }
    }
    // An inner scroller at its edge still yields to an ancestor with room.
    // Editor content may live in a shadow root (for example a diff viewer).
    const parent = node.parentElement;
    const root = parent === null ? node.getRootNode() : null;
    node = parent ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return { back, forward };
}
