import { useSyncExternalStore } from "react";

/**
 * The one owner of the canvas editor's width threshold (L-02, L-64).
 *
 * 1100px: a 320px instrument panel plus the app column at its own 768px
 * breakpoint. Below it the app cannot reflow beside the inspector, so the door
 * opens the full-width `Settings > Layout` host instead and a live session
 * exits; the sample workspace, which exists only to be that canvas, closes with
 * it.
 *
 * Deliberately NOT `useIsMobileViewport()`, which answers a different question
 * at a different number (768px, "is this the phone layout?"). Three surfaces
 * used to read that hook for this decision, which meant the editor opened into
 * a 900px window with no room for either half of itself.
 */
export const LAYOUT_EDITOR_MIN_WIDTH = 1100;

/**
 * Imperative read, for the command-time call sites that must not re-render on
 * a resize: the door, and the live session's own watcher.
 */
export function layoutEditorFitsWindow(): boolean {
  return window.innerWidth >= LAYOUT_EDITOR_MIN_WIDTH;
}

/**
 * The one owner of the EDGE as well as of the number (L-64).
 *
 * A `resize` listener rather than a media query because the answer above is
 * `window.innerWidth`: measuring the value one way and the change another left
 * the two halves of `useLayoutEditorFitsWindow` disagreeing, and the live
 * session watching a third thing again.
 */
export function subscribeLayoutEditorFitsWindow(
  onChange: () => void,
): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The same answer, subscribed, for the surfaces that live through a resize. */
export function useLayoutEditorFitsWindow(): boolean {
  return useSyncExternalStore(
    subscribeLayoutEditorFitsWindow,
    layoutEditorFitsWindow,
    serverSnapshot,
  );
}

function serverSnapshot(): boolean {
  return true;
}
