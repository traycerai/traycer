import type { MouseEvent } from "react";

/**
 * A middle-button activation arrives as `auxclick`, never `click`, so an
 * anchor that routes through `openLink` from `onClick` alone misses it twice:
 * the seam never runs, and the anchor's own default is never prevented (A3).
 * Wrap the same handler for `onAuxClick`.
 *
 * The right button lands here too and stays the browser's - it belongs to the
 * context menu, not to a link open.
 */
export function onMiddleClick<E extends Element>(
  handler: (event: MouseEvent<E>) => void,
): (event: MouseEvent<E>) => void {
  return (event: MouseEvent<E>): void => {
    if (event.button !== 1) return;
    handler(event);
  };
}
