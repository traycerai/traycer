/**
 * Global "a panel resize drag is in progress" signal, expressed as the
 * `traycer-panel-resizing` class on `<html>`. Expensive surfaces opt into
 * freezing during a drag via `[.traycer-panel-resizing_&]:...` descendant
 * selectors so per-frame reflows stay cheap: overlay chrome (chat minimap,
 * scroll-to-bottom chip) hides via opacity, and transcript rows
 * (`ChatMessageRow`) flip to `content-visibility: hidden` so intermediate
 * drag widths never re-wrap and re-rasterize every visible pane. Shared by
 * every resize handle in the app - the canvas/sidebar-section
 * `SplitResizeHandle` and the hoisted sidebar's width handle - so consumers
 * never care which surface drove the drag.
 */
const PANEL_RESIZING_CLASS_NAME = "traycer-panel-resizing";

let stopPanelResizeInteraction: (() => void) | null = null;

export function isPanelResizeInteractionActive(): boolean {
  return stopPanelResizeInteraction !== null;
}

export function beginPanelResizeInteraction(
  pointerId: number,
  onStop: () => void,
): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => undefined;
  }

  stopPanelResizeInteraction?.();
  document.documentElement.classList.add(PANEL_RESIZING_CLASS_NAME);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    document.documentElement.classList.remove(PANEL_RESIZING_CLASS_NAME);
    window.removeEventListener("pointerup", stopForEvent);
    window.removeEventListener("pointercancel", stopForEvent);
    window.removeEventListener("blur", stopForEvent);
    if (stopPanelResizeInteraction === stop) {
      stopPanelResizeInteraction = null;
    }
    onStop();
  };

  const stopForEvent = (event: Event): void => {
    if (event.type !== "blur") {
      const eventPointerId =
        "pointerId" in event && typeof event.pointerId === "number"
          ? event.pointerId
          : null;
      if (eventPointerId !== pointerId) return;
    }
    stop();
  };

  stopPanelResizeInteraction = stop;
  window.addEventListener("pointerup", stopForEvent);
  window.addEventListener("pointercancel", stopForEvent);
  window.addEventListener("blur", stopForEvent);
  return stop;
}
