import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";

/** `true` when this window already holds restorable content - an open tab, a canvas epic tab, or a landing draft. */
export function hasRestoredTabs(): boolean {
  if (useTabsStore.getState().stripOrder.length > 0) return true;
  if (useEpicCanvasStore.getState().openTabOrder.length > 0) return true;
  if (useLandingDraftStore.getState().drafts.length > 0) return true;
  return false;
}
