import { useEffect, useRef, type RefObject } from "react";

export interface ModalSurfaceContainment {
  /**
   * Whether the surface is modal RIGHT NOW. This is the discrete semantic
   * state, never a continuous visual one: a surface that is half dragged into
   * view may still spring back, and trapping focus into something about to
   * disappear is worse than not trapping it at all.
   */
  readonly active: boolean;
  /**
   * The surface's own top-level node, which must be a direct child of the
   * document body. Everything beside it becomes inert, so a surface nested
   * inside the app tree would inert itself.
   */
  readonly layerRef: RefObject<HTMLElement | null>;
  /** What receives focus on the way in. */
  readonly focusRef: RefObject<HTMLElement | null>;
  readonly onDismiss: () => void;
}

/**
 * Makes a body-level surface modal for as long as it is active: the rest of the
 * document goes inert, focus moves into the surface and returns to where it
 * came from on the way out, and Escape dismisses.
 *
 * `inert` is one attribute doing the work of three libraries. An inert subtree
 * is not hit-tested, holds no focus and is not exposed to assistive technology,
 * so applying it to every body child EXCEPT the surface leaves exactly one
 * reachable region - which is the whole definition of modal. Doing it by
 * enumeration rather than by inerting a single app root also covers the other
 * body-level portals (toasts, popovers), which an app-root-only rule would
 * leave interactive behind the surface.
 *
 * Prior inert state is recorded per node and restored, so nesting this inside
 * another already-inert region cannot un-inert it on the way out.
 */
export function useModalSurfaceContainment(
  containment: ModalSurfaceContainment,
): void {
  const { active, layerRef, focusRef } = containment;
  const dismissRef = useRef(containment.onDismiss);
  useEffect(() => {
    dismissRef.current = containment.onDismiss;
  });

  useEffect(() => {
    if (!active) return;
    const layer = layerRef.current;
    // Captured before focus moves, restored on the way out. A surface that
    // swallows the caller's focus point and never gives it back strands a
    // keyboard user at the top of the document.
    const restoreFocusTo = document.activeElement;
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (layer !== null && child.contains(layer)) continue;
      if (child.inert) continue;
      child.inert = true;
      inerted.push(child);
    }
    focusRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      dismissRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const node of inerted) node.inert = false;
      if (restoreFocusTo instanceof HTMLElement && restoreFocusTo.isConnected) {
        restoreFocusTo.focus();
      }
    };
  }, [active, layerRef, focusRef]);
}
