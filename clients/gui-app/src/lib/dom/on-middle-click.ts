import type { MouseEvent } from "react";

/**
 * A middle-button activation arrives as `auxclick`, never `click`, so a
 * control wired only through `onClick` misses it twice: the seam never runs
 * (`openLink` / `openTile` never see `middle`), and an anchor's own default
 * is never prevented (A3, C4).
 *
 * The right button lands here too and stays the browser's - it belongs to the
 * context menu, not to an open.
 */
export function onMiddleClick<E extends Element>(
  handler: (event: MouseEvent<E>) => void,
): (event: MouseEvent<E>) => void {
  return (event: MouseEvent<E>): void => {
    if (event.button !== 1) return;
    handler(event);
  };
}
