import {
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Handlers for a control that must survive its own surface being replaced
 * mid-press. Spread onto the element; never combine with a separate `onClick`.
 */
export interface PressStartActivation {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Activation that fires on PRESS rather than on click, for the boot card's
 * escape hatch.
 *
 * WHY THIS EXISTS - measured, not theorised. A launch crosses several boot
 * surfaces (`HostRuntimeBootFallback`, the gate's card, the narrator's
 * `WindowHostStartupCard`), and they are deliberately pixel-identical, so the
 * card looks continuous while the DOM under it is replaced. A CDP capture of a
 * real user press on the production `Open settings` link recorded:
 *
 *   pointerdown -> button[host-boot-open-settings]
 *   mousedown   -> button[host-boot-open-settings]
 *   mouseup     -> the tree that replaced it, 198ms later
 *   (no click event at all)
 *
 * Chromium emitted NO click, because the pressed element had been removed from
 * the document before release. `onClick` therefore never ran, the navigation
 * never happened, and the user saw an unchanged card - the whole reported bug.
 * The card's clickable lifetime on that machine was ~300-500ms per launch, so
 * a press only has to be slightly late to straddle a hand-off.
 *
 * Do not "fix" this back to a plain `onClick`, and do not try to hold the
 * surface still while a pointer is down: pointer capture does not survive the
 * node being removed, and gating readiness hand-offs on pointer lifecycle
 * (pointercancel, window blur, lost capture) trades a lost click for a stuck
 * launch.
 *
 * ONLY FOR SAFE NAVIGATION. This is for escape hatches that a user can repeat
 * harmlessly - opening Settings. It must NOT be used for mutations (Retry,
 * Update host, Reinstall): press-start activation deliberately ignores
 * drag-away and pointer-cancel, so a press that the user changes their mind
 * about still fires. That is the right trade for "let me out of this stuck
 * launch" and the wrong one for anything that changes state.
 *
 * TOUCH. A primary touch activates at gesture start, before it is known to be
 * a tap rather than a scroll or long-press. Accepted for this control on this
 * surface, where there is nothing to scroll.
 *
 * KEYBOARD IS UNAFFECTED. A keyboard-activated button (Enter/Space), a screen
 * reader's activation and a programmatic `.click()` all arrive as a click with
 * `detail === 0` and no pointer press behind them, so they take the `onClick`
 * path. Any click with `detail >= 1` is the tail of a pointer press this hook
 * already handled at `pointerdown` - it is dropped, so the action fires once,
 * not twice.
 */
export function usePressStartActivation(
  onActivate: () => void,
): PressStartActivation {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      // Primary button of the primary pointer only. Without this, a
      // right-click (which opens a context menu and fires no click) or a
      // secondary touch point would navigate.
      if (event.button !== 0 || !event.isPrimary) return;
      // Deliberately no `preventDefault()`: it would suppress focus and the
      // compatibility mouse events, changing behaviour well beyond this fix.
      onActivate();
    },
    [onActivate],
  );

  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      if (event.detail !== 0) return;
      onActivate();
    },
    [onActivate],
  );

  return { onPointerDown, onClick };
}
