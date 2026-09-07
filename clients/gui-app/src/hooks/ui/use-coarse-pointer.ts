import { useSyncExternalStore } from "react";

/**
 * Touch-grade pointer, not viewport width and not which build. A narrow desktop window is not coarse; a tablet at desktop width is.
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
