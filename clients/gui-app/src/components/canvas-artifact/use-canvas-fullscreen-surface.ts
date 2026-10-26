import { useEffectEvent, useLayoutEffect } from "react";
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
  // The callbacks change with the board shown, and the effect must not follow
  // them: re-running it would move focus back to the exit button on every
  // step, out from under a reader stepping with the header buttons.
  const onKey = useEffectEvent((element: HTMLElement, event: KeyboardEvent) => {
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
  });
  useLayoutEffect(() => {
    const element = surface;
    if (!active || element === null) return;
    const previous = document.activeElement;
    element.querySelector<HTMLButtonElement>("[data-canvas-exit]")?.focus();
    const listener = (event: KeyboardEvent): void => onKey(element, event);
    element.addEventListener("keydown", listener);
    return () => {
      element.removeEventListener("keydown", listener);
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (document.activeElement === document.body ||
          element.contains(document.activeElement))
      )
        previous.focus({ preventScroll: true });
    };
  }, [active, surface]);
}
