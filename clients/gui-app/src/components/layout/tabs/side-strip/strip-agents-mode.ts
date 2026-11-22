import { useSideStripDrawnCollapsed } from "@/components/layout/tabs/mobile-strip-form-context";
import { useTabStripPlacement } from "@/components/layout/tabs/use-tab-strip-placement";
import { useArrangementValue } from "@/lib/layout-overrides";
import {
  liveAgentsInStrip,
  type SideStripView,
} from "@/lib/layout/layout-arrangement";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * The view the strip draws. The installed app offers neither the Side tab
 * view row nor the layout editor, so its strip would be the plain list for
 * good; it draws the Activity view instead, the one that lists a task's
 * agents and sorts tasks by what they need, as the desktop strip does once the
 * person chooses it.
 */
function useSideStripView(): SideStripView {
  const stored = useArrangementValue("sideStripView");
  return isPhoneLayoutOnly() ? "activity" : stored;
}

/**
 * How the tasks' nested agents draw: `live` in the Activity view, and
 * `preview` while the layout editor points at Side tab view in Tabs only, so
 * the agents the other value adds show ghosted before it is chosen.
 * `null` when the strip has no room for them: at the top, or collapsed.
 */
export function useStripAgentsMode(): "live" | "preview" | null {
  const placement = useTabStripPlacement();
  const collapsed = useSideStripDrawnCollapsed();
  const view = useSideStripView();
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
  const collapsed = useSideStripDrawnCollapsed();
  const view = useSideStripView();
  return liveAgentsInStrip(placement, collapsed, view);
}

/**
 * Whether the strip draws the Activity view's sections: expanded as a list,
 * collapsed as the rail's runs of tiles. The Layered view never does, and
 * neither does a strip at the top.
 */
export function useSectionedStrip(): boolean {
  const placement = useTabStripPlacement();
  const view = useSideStripView();
  return liveAgentsInStrip(placement, false, view);
}
