/**
 * Global "a panel resize drag is in progress" signal, expressed as the
 * `traycer-panel-resizing` class on `<html>`. Before the class is added,
 * registered transcript surfaces imperatively snapshot their currently
 * visible rows. Descendant selectors keep those marked rows live, freeze only
 * unmarked/off-screen rows, and suppress transient resize chrome without any
 * per-scroll React subscription. Snapshot markers are cleared after the class
 * is removed. The signal is shared by every resize handle, so consumers do
 * not need to know which surface started the drag.
 */
import { appLogger } from "@/lib/logger";

const PANEL_RESIZING_CLASS_NAME = "traycer-panel-resizing";

let stopPanelResizeInteraction: (() => void) | null = null;

export function isPanelResizeInteractionActive(): boolean {
  return stopPanelResizeInteraction !== null;
}

interface PanelResizeParticipant {
  /** Runs once, synchronously, right before the global class is added. */
  readonly capture: () => void;
  /** Runs once, synchronously, right after the global class is removed. */
  readonly clear: () => void;
}

const panelResizeParticipants = new Set<PanelResizeParticipant>();

/**
 * Registers a surface (ticket 23's D20 port: one per mounted `ChatTimeline`)
 * that imperatively snapshots/clears its own visible-row markers around a
 * panel-resize drag. Returns an unregister function. A participant's own
 * `capture`/`clear` failure is isolated (logged, not thrown) so one broken
 * tile never blocks the drag's class lifecycle or another tile's own
 * capture/clear.
 */
export function registerPanelResizeParticipant(
  participant: PanelResizeParticipant,
): () => void {
  panelResizeParticipants.add(participant);
  return () => {
    panelResizeParticipants.delete(participant);
  };
}

function runPanelResizeParticipants(step: "capture" | "clear"): void {
  for (const participant of panelResizeParticipants) {
    try {
      participant[step]();
    } catch (error) {
      appLogger.errorSummary(
        "[panel-resize] participant failed",
        { step },
        error,
      );
    }
  }
}

export function beginPanelResizeInteraction(
  pointerId: number,
  onStop: () => void,
): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => undefined;
  }

  stopPanelResizeInteraction?.();
  runPanelResizeParticipants("capture");
  document.documentElement.classList.add(PANEL_RESIZING_CLASS_NAME);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    document.documentElement.classList.remove(PANEL_RESIZING_CLASS_NAME);
    runPanelResizeParticipants("clear");
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
