import { createContext, use, useEffect } from "react";

/**
 * Keeps an open overlay's anchor in the page.
 *
 * A windowed list unmounts a row as soon as it leaves the window, and a card,
 * tooltip or menu anchored to that row would go with it. The list provides
 * this per row: `hold` keeps the row mounted until the returned release runs.
 * Nothing provides it anywhere else, and the hook below then does nothing.
 */
export const OverlayAnchorHoldContext = createContext<
  (() => () => void) | null
>(null);

/** Holds the surrounding anchor while `open`. */
export function useOverlayAnchorHold(open: boolean): void {
  const hold = use(OverlayAnchorHoldContext);
  useEffect(() => {
    if (hold === null || !open) return;
    return hold();
  }, [hold, open]);
}
