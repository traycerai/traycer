import { useRef } from "react";

/**
 * How long a caller waits for the picker to leave the screen before going on
 * anyway. The menu's exit animation is a tenth of that; the bound only exists
 * for a menu whose content was never presented (a pane that lost focus
 * mid-pick), which has no exit to report.
 */
const MENU_CLOSE_WAIT_MS = 500;

export interface ChatTargetMenuClosed {
  /** Wire to `ChatTargetMenu.onOpenChange`, wrapping the caller's own setter. */
  readonly onOpenChange: (open: boolean) => void;
  /** Wire to `ChatTargetMenu.onClosed`. */
  readonly onClosed: () => void;
  /** Resolves once the menu is off screen, at once if it never opened. */
  readonly awaitClosed: () => Promise<void>;
}

/**
 * Lets a caller wait for the picker to be GONE, not merely closed. `open`
 * flips false the moment a chat is picked, but the menu keeps painting through
 * its exit animation; a window screenshot taken then has the fading menu in
 * it. `onClosed` fires from the menu's unmount, after that animation.
 */
export function useChatTargetMenuClosed(
  setOpen: (open: boolean) => void,
): ChatTargetMenuClosed {
  const present = useRef(false);
  const waiter = useRef<(() => void) | null>(null);
  return {
    onOpenChange: (open) => {
      if (open) present.current = true;
      setOpen(open);
    },
    onClosed: () => {
      present.current = false;
      waiter.current?.();
      waiter.current = null;
    },
    awaitClosed: () => {
      if (!present.current) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = window.setTimeout(resolve, MENU_CLOSE_WAIT_MS);
        waiter.current = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}
