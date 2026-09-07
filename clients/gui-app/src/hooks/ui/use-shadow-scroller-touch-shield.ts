import { useCallback, useRef } from "react";

/** Stop touchmove at the light-DOM wrapper of a shadow-rooted scroller so a document-level scroll lock cannot freeze iOS native pan.
 * Ancestors that must hear these gestures need capture-phase listeners. */
export function useShadowScrollerTouchShield(): (
  node: HTMLElement | null,
) => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback((node: HTMLElement | null) => {
    if (cleanupRef.current !== null) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (node === null) return;
    const stopTouchMove = (event: TouchEvent): void => {
      event.stopPropagation();
    };
    node.addEventListener("touchmove", stopTouchMove);
    cleanupRef.current = () => {
      node.removeEventListener("touchmove", stopTouchMove);
    };
  }, []);
}
