import { create } from "zustand";
import { useTabStripPlacement } from "@/components/layout/tabs/use-tab-strip-placement";
import { useArrangementValue } from "@/lib/layout-overrides";
import { liveAgentsInStrip } from "@/lib/layout/layout-arrangement";
import { useSideStripCollapsed } from "@/stores/layout/side-tab-strip-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * Where the strip wants the active task's live agents drawn (D9): the element
 * under the active row, and the tab it belongs to. The strip publishes it;
 * that tab's epic surface portals its list into it, so the list keeps its
 * session context and no second session mounts.
 *
 * One per window: only the active row, or the focused half of an active
 * split, ever holds the slot.
 */
interface LiveAgentsSlot {
  readonly tabId: string;
  readonly element: HTMLElement;
}

const useLiveAgentsSlotStore = create<{ readonly slot: LiveAgentsSlot | null }>(
  () => ({ slot: null }),
);

/** Publishes `element` as the slot for `tabId`; the returned cleanup withdraws it. */
export function publishLiveAgentsSlot(
  tabId: string,
  element: HTMLElement,
): () => void {
  const slot: LiveAgentsSlot = { tabId, element };
  useLiveAgentsSlotStore.setState({ slot });
  return () => {
    // A newer slot may have been published before this one's cleanup ran.
    if (useLiveAgentsSlotStore.getState().slot !== slot) return;
    useLiveAgentsSlotStore.setState({ slot: null });
  };
}

/** The slot element while the strip wants `tabId`'s live agents, else `null`. */
export function useLiveAgentsSlot(tabId: string): HTMLElement | null {
  return useLiveAgentsSlotStore((state) =>
    state.slot?.tabId === tabId ? state.slot.element : null,
  );
}

/**
 * How the active row's live agents draw: `live` in the Activity view, and
 * `preview` while the layout editor points at Side tab view in Tabs only, so
 * the list the other value adds shows ghosted before it is chosen (C3). `null`
 * when the strip has no room for it: at the top, or collapsed.
 */
export function useLiveAgentsSlotMode(): "live" | "preview" | null {
  const placement = useTabStripPlacement();
  const collapsed = useSideStripCollapsed();
  const view = useArrangementValue("sideStripView");
  const pointed = useLayoutEditorStore(
    (state) =>
      state.hoveredSetting === "sideStripView" ||
      state.selectedSetting === "sideStripView",
  );
  if (liveAgentsInStrip(placement, collapsed, view)) return "live";
  if (!pointed || !liveAgentsInStrip(placement, collapsed, "activity"))
    return null;
  return "preview";
}

/** Whether this window's strip lists live agents at all (D9). */
export function useLiveAgentsInStrip(): boolean {
  const placement = useTabStripPlacement();
  const collapsed = useSideStripCollapsed();
  const view = useArrangementValue("sideStripView");
  return liveAgentsInStrip(placement, collapsed, view);
}
