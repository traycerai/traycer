import { useLayoutEffect } from "react";
import { isCanvasTextInput } from "./canvas-model";

function stepDirection(code: string): -1 | 1 | null {
  if (code === "ArrowLeft") return -1;
  if (code === "ArrowRight") return 1;
  return null;
}
/**
 * Fullscreen is scoped to the canvas tile: the existing canvas DOM is promoted
 * in place (moving an iframe into a dialog reloads it), the rest of the window
 * stays usable, Escape inside the tile leaves fullscreen, and the left and
 * right arrows step through the boards. A key pressed inside the board's
 * frame arrives here too, replayed on the frame element by the sandbox bridge.
 */
export function useCanvasFullscreenSurface(
  surface: HTMLDivElement | null,
  active: boolean,
  onClose: () => void,
  onStep: (direction: -1 | 1) => void,
): void {
  useLayoutEffect(() => {
    const element = surface;
    if (!active || element === null) return;
    const previous = document.activeElement;
    element.querySelector<HTMLButtonElement>("[data-canvas-exit]")?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.code === "Escape") {
        // The draft owns Escape and its dirty-text confirmation.
        if (element.querySelector("[data-slot=anchored-draft-popover]")) return;
        event.preventDefault();
        onClose();
        return;
      }
      const direction = stepDirection(event.code);
      if (
        direction === null ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        // A field, menu or dialog inside the surface keeps its own arrows.
        isCanvasTextInput(event.target, element)
      )
        return;
      event.preventDefault();
      onStep(direction);
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
  }, [active, surface, onClose, onStep]);
}
