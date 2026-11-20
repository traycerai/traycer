import { createContext, use } from "react";

/**
 * DOM node that overlays raised inside a TOP-LAYER surface portal into.
 *
 * A surface promoted to the top layer - an expanded artifact
 * (`artifact-expansion.tsx`) - paints above everything that is not in the top
 * layer, whatever its z-index. A menu, tooltip or popover portalled to
 * `document.body` therefore renders UNDER the surface that opened it: mounted,
 * invisible, unreachable. Publishing the promoted element here keeps those
 * portals inside it.
 *
 * Those three are wired because those three are raised inside a promoted
 * surface today (the chip's menus, the toolbars' labels, the pages popover).
 * Another primitive joins them when something inside a surface uses it, not
 * before.
 *
 * `null` everywhere else, where `document.body` stays the target, so nothing
 * outside a promoted surface changes. A call site's own `container` still
 * wins, and the modal-dialog boundary keeps its own precedence where it
 * already had it ({@link DialogOverlayBoundaryContext}).
 */
export const SurfaceOverlayContainerContext = createContext<HTMLElement | null>(
  null,
);

export function useSurfaceOverlayContainerEl(): HTMLElement | null {
  return use(SurfaceOverlayContainerContext);
}
