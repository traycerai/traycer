import { useSyncExternalStore } from "react";

/**
 * INPUT signal: "is a touch-grade pointer driving this window?"
 *
 * The device counterpart of `useIsMobileViewport()`, which answers a pure
 * layout question. Use this one only for chrome whose CSS is already behind
 * `@media(pointer:fine)` and whose work is worth skipping when it cannot
 * paint - hover affordances that measure. A narrow desktop window is not
 * coarse, and a tablet at desktop width is.
 */
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeToCoarsePointerQuery(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia(COARSE_POINTER_QUERY);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function readCoarsePointerSnapshot(): boolean {
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

function readCoarsePointerServerSnapshot(): boolean {
  return false;
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeToCoarsePointerQuery,
    readCoarsePointerSnapshot,
    readCoarsePointerServerSnapshot,
  );
}
