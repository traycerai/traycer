import * as React from "react";

/**
 * Height (CSS px) of the layout viewport currently covered by the on-screen
 * keyboard, or 0 when no keyboard is up (or the browser resizes the layout
 * itself, e.g. Android with `interactive-widget=resizes-content`, or the
 * Capacitor webview in native-resize mode - both leave nothing covered).
 *
 * iOS Safari never resizes the page for the keyboard: it overlays it, so a
 * bar at the bottom of the `h-dvh` app shell disappears behind it. The
 * covered amount is layout-viewport height minus the visual viewport's height
 * and top offset (iOS shifts the visual viewport when it scrolls a focused
 * field into view). `document.documentElement.clientHeight` is the layout
 * anchor here - `window.innerHeight` is useless for this on iOS because it
 * tracks the visual viewport and shrinks with the keyboard.
 */
/**
 * Differences below this are not a keyboard: no soft keyboard is this short,
 * while iOS toolbar expand/collapse can leave the layout and visual viewports
 * disagreeing by up to ~100px at rest. Without the floor that disagreement
 * would read as permanent phantom padding.
 */
const MIN_KEYBOARD_INSET_PX = 120;

export function readVirtualKeyboardInset(): number {
  const viewport = window.visualViewport ?? null;
  if (viewport === null) return 0;
  // Pinch zoom shrinks visualViewport.height (CSS px scale with zoom) while
  // the layout viewport doesn't move - at 2x the formula would report half
  // the screen as "keyboard". Zoom is deliberately reachable (accessibility
  // pinch bypasses maximum-scale=1), so bail to 0 rather than mis-measure.
  if (viewport.scale !== 1) return 0;
  const layoutHeight = document.documentElement.clientHeight;
  const inset = Math.round(layoutHeight - viewport.height - viewport.offsetTop);
  return inset < MIN_KEYBOARD_INSET_PX ? 0 : inset;
}

function subscribeToViewportChanges(onChange: () => void): () => void {
  const viewport = window.visualViewport ?? null;
  if (viewport === null) return () => {};
  // `resize` covers keyboard show/hide; `scroll` covers iOS moving the visual
  // viewport within the layout viewport while the keyboard stays up.
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
  };
}

function readServerSnapshot(): number {
  return 0;
}

export function useVirtualKeyboardInset(): number {
  return React.useSyncExternalStore(
    subscribeToViewportChanges,
    readVirtualKeyboardInset,
    readServerSnapshot,
  );
}
