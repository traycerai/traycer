import { useTabStripPlacement } from "@/components/layout/tabs/use-tab-strip-placement";
import { useArrangementValue } from "@/lib/layout-overrides";
import { liveAgentsInStrip } from "@/lib/layout/layout-arrangement";
import { useSideStripCollapsed } from "@/stores/layout/side-tab-strip-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * How the tasks' nested agents draw: `live` in the Activity view, and
 * `preview` while the layout editor points at Side tab view in Tabs only, so
 * the agents the other value adds show ghosted before it is chosen (C3).
 * `null` when the strip has no room for them: at the top, or collapsed.
 */
export function useStripAgentsMode(): "live" | "preview" | null {
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
