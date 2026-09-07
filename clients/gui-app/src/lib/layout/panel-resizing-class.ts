/**
 * Global "a panel resize drag is in progress" signal, expressed as the `traycer-panel-resizing` class on `<html>`.
 * Before the class is added, registered transcript surfaces imperatively snapshot their currently visible rows.
 */
import { appLogger } from "@/lib/logger";

export const PANEL_RESIZING_CLASS_NAME = "traycer-panel-resizing";

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
 * Registers a surface (ticket 23's D20 port: one per mounted `ChatTimeline`) that imperatively snapshots/clears its own visible-row markers around a panel-resize drag.
 * Returns an unregister function.
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
