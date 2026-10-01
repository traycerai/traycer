import { useLayoutEffect, useState } from "react";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  useLayoutEditorStore,
  type LayoutSettingId,
  type PlacementSurfaceId,
} from "@/stores/layout/layout-editor-store";

/**
 * Marks the element that draws a placement surface - the tab strip in either
 * placement, the canvas's sidebar - so the canvas can select it (D14).
 *
 * The surface's sibling of `useLayoutRegion`, and gated the same way: only
 * while a session is live, and never from a hidden pane. `data-layout-surface`
 * is what the canvas resolves a press against, and the registry entry is what
 * the ring and the placement bar measure.
 */
export function useLayoutSurface(
  surface: PlacementSurfaceId,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const editing = useLayoutEditorStore((state) => state.session !== null);
  const visible = usePaneVisible();
  // A layout effect, so a placement write that swaps the strip for its other
  // component registers the new element before the next frame: the ring and
  // the bar hold across the swap instead of losing the surface for a frame.
  useLayoutEffect(() => {
    if (node === null || !editing || !visible) return;
    node.setAttribute("data-layout-surface", surface);
    useLayoutEditorStore.getState().registerSurfaceNode(surface, node);
    return () => {
      node.removeAttribute("data-layout-surface");
      useLayoutEditorStore.getState().unregisterSurfaceNode(surface, node);
    };
  }, [node, editing, visible, surface]);
  return setNode;
}

/**
 * Marks the element that draws a setting's part on the canvas - the live
 * agents list under the active tab for Side tab view - so the canvas can hover
 * and select it and the ring can go around it. Gated like
 * {@link useLayoutSurface}. `data-hover` is the same outline a hovered region
 * wears; the selected one wears the ring instead.
 */
export function useLayoutSettingPart(
  setting: LayoutSettingId,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const editing = useLayoutEditorStore((state) => state.session !== null);
  const hovered = useLayoutEditorStore(
    (state) =>
      state.hoveredSetting === setting && state.selectedSetting !== setting,
  );
  const visible = usePaneVisible();
  useLayoutEffect(() => {
    if (node === null || !editing || !visible) return;
    node.setAttribute("data-layout-setting", setting);
    useLayoutEditorStore.getState().registerSettingNode(setting, node);
    return () => {
      node.removeAttribute("data-layout-setting");
      useLayoutEditorStore.getState().unregisterSettingNode(setting, node);
    };
  }, [node, editing, visible, setting]);
  useLayoutEffect(() => {
    if (node === null || !hovered) return;
    node.setAttribute("data-hover", "1");
    return () => {
      node.removeAttribute("data-hover");
    };
  }, [node, hovered]);
  return setNode;
}
