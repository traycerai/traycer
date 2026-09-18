import { blockingLayerClaimed } from "./blocking-layer-claim";

/** Route-backed overlays are part of history; decision dialogs are not. */
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

/** Sample once at the start; a content scroll never becomes navigation at its boundary. */
export function ownsDesktopHorizontalWheel(
  target: EventTarget | null,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node !== null) {
    if (
      node.matches("[data-history-gesture-owner], .react-flow, webview, iframe")
    )
      return true;
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = window.getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
      if (node instanceof HTMLInputElement) return true;
    }
    // Editor content may live in a shadow root (for example a diff viewer).
    const parent = node.parentElement;
    const root = parent === null ? node.getRootNode() : null;
    node = parent ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}
