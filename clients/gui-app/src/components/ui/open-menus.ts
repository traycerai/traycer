import { useEffect, useSyncExternalStore, type ReactNode } from "react";

/**
 * Whether any menu (context or dropdown) is open anywhere in the window, so a
 * hover card can stay shut while one is.
 *
 * A NON-modal menu (the tab strips' context menu is one - Edit Title needs it)
 * leaves the page's pointer events on, so without this a row resting under
 * the pointer beside the menu arms its card and opens it over the menu.
 */
let openMenuCount = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readAnyMenuOpen(): boolean {
  return openMenuCount > 0;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Rendered as a child of a menu's `Content`, which mounts only while the menu
 * is open (and through its exit animation), so its lifetime is the menu's.
 */
export function MenuOpenMarker(): ReactNode {
  useEffect(() => {
    openMenuCount += 1;
    emit();
    return () => {
      openMenuCount -= 1;
      emit();
    };
  }, []);
  return null;
}

export function useAnyMenuOpen(): boolean {
  return useSyncExternalStore(subscribe, readAnyMenuOpen, readAnyMenuOpen);
}
