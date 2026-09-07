import {
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Handlers for a control that must survive its own surface being replaced mid-press.
 * Spread onto the element; never combine with a separate `onClick`.
 */
export interface PressStartActivation {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Fire on press, not click: boot cards replace the DOM mid-press so Chromium emits no click.
 * Escape-hatch navigation only (not mutations); `detail >= 1` click is dropped as the pointer tail.
 */
export function usePressStartActivation(
  onActivate: () => void,
): PressStartActivation {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      // Primary button of the primary pointer only.
      // Without this, a right-click (which opens a context menu and fires no click) or a secondary touch point would navigate.
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
