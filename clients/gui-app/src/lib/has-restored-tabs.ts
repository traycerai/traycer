import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * `true` when this window already holds restorable content - an open tab, a
 * canvas epic tab, or a landing draft.
 *
 * Reads the three stores synchronously, so callers must decide when it is safe
 * to trust the answer. In Electron the stores are authoritative only AFTER
 * `WindowsBridgeProvider` has applied the per-window desktop snapshot; before
 * that they hold stale localStorage residue. Route guards run on preload and
 * cannot await hydration, so the `/draft/new` creation path re-checks this once
 * `useWindowsBridgeHydrated()` reports the snapshot has landed.
 */
export function hasRestoredTabs(): boolean {
  if (useTabsStore.getState().stripOrder.length > 0) return true;
  if (useEpicCanvasStore.getState().openTabOrder.length > 0) return true;
  if (useLandingDraftStore.getState().drafts.length > 0) return true;
  return false;
}
