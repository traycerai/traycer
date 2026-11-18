import { useSyncExternalStore } from "react";

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

function subscribe(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia(HOVER_QUERY);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(HOVER_QUERY).matches;
}

export function useHoverCapable(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
