import { useLayoutEffect } from "react";
/**
 * Fullscreen is scoped to the canvas tile: the existing canvas DOM is promoted
 * in place (moving an iframe into a dialog reloads it), the rest of the window
 * stays usable, and Escape inside the tile leaves fullscreen.
 */
export function useCanvasFullscreenSurface(
  surface: HTMLDivElement | null,
  active: boolean,
  onClose: () => void,
): void {
  useLayoutEffect(() => {
    const element = surface;
    if (!active || element === null) return;
    const previous = document.activeElement;
    element.querySelector<HTMLButtonElement>("[data-canvas-exit]")?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // The draft owns Escape and its dirty-text confirmation.
      if (element.querySelector("[data-slot=anchored-draft-popover]")) return;
      event.preventDefault();
      onClose();
    };
    element.addEventListener("keydown", onKey);
    return () => {
      element.removeEventListener("keydown", onKey);
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (document.activeElement === document.body ||
          element.contains(document.activeElement))
      )
        previous.focus({ preventScroll: true });
    };
  }, [active, surface, onClose]);
}
