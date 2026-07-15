import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Opens an epic in a background header tab without leaving the current
 * surface - the active tab and route are untouched, so the History overlay
 * stays open and the `/epics` / home lists keep their place. Reuses an
 * existing tab for the epic when one is already open.
 *
 * Centralised here (mirroring `openEpicFromList`) so the history row's
 * right-click action and any future entry point stay in lockstep.
 */
export function openEpicInBackground(
  epicId: string,
  title: string | undefined,
): void {
  Analytics.getInstance().track(AnalyticsEvent.TaskOpened, {
    source: "direct_ui",
  });
  useEpicCanvasStore.getState().openEpicTabInBackground(epicId, title);
}
