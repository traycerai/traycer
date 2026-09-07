import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Opens an epic in a background header tab without leaving the current surface - the active tab and route are untouched, so the History overlay stays open and the `/epics` / home lists keep their place.
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
