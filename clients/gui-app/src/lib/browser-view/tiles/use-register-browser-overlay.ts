import { useCallback, useRef } from "react";
import { registerBrowserOverlay } from "./browser-overlay-coordinator";

/**
 * Registers the element it is attached to as a live occlusion surface for
 * as long as it stays mounted - the overlay-side counterpart of
 * `useBrowserViewBoundsBridge`'s tile registration. One shared hook so
 * every content wrapper gets registration for free instead of reimplementing
 * this per primitive.
 *
 * Returns a ref CALLBACK, not an effect keyed on a `RefObject`: several
 * callers (every Radix `*Content` wrapper, and every hand-rolled popover
 * that renders conditionally from an always-mounted parent, e.g.
 * `FloatingDraftPopover`) keep the SAME React component instance mounted
 * across the DOM node's own mount/unmount cycles - an effect with stable
 * deps would only ever see the ref's very first value and never re-fire. A
 * ref callback is invoked by React exactly when the underlying DOM node
 * itself mounts and unmounts, independent of the owning component's
 * lifecycle, which is what registration has to track.
 *
 * Takes no ref of its own: compose the returned callback with a caller's
 * forwarded ref via `useComposedRefs` (from `radix-ui/internal`), which
 * stays IDENTITY-STABLE across re-renders - unlike an inline `mergeRefs(...)`
 * call, which produces a new function every render and makes React tear
 * down and re-run this ref callback (re-registering the overlay) on every
 * re-render of the owning component.
 */
export function useRegisterBrowserOverlay<T extends HTMLElement>(): (
  node: T | null,
) => void {
  const deregister = useRef<(() => void) | null>(null);
  return useCallback((node: T | null) => {
    deregister.current?.();
    deregister.current =
      node === null ? null : registerBrowserOverlay({ element: node });
  }, []);
}
