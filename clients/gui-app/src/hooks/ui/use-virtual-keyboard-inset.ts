import * as React from "react";

/** Overlay keyboard inset. Consumers gate on !isMobileApp(). Use documentElement.clientHeight, not window.innerHeight. */
/** Differences below this are not a keyboard: no soft keyboard is this short, while iOS toolbar expand/collapse can leave the layout and visual viewports disagreeing by up to ~100px at rest. */
const MIN_KEYBOARD_INSET_PX = 120;

export function readVirtualKeyboardInset(): number {
  const viewport = window.visualViewport ?? null;
  if (viewport === null) return 0;
  // Zoom is deliberately reachable (accessibility pinch bypasses maximum-scale=1), so bail to 0 rather than mis-measure.
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
