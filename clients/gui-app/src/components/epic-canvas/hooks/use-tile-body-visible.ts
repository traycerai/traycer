import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";

/**
 * Whether a tile body is actually on screen: its pane is the shown pane AND its
 * tab is the front (selected) tab. Mounted-but-concealed keep-alive bodies
 * (`display:none`) read `false`. Single source of truth for the
 * scroll-restoration hooks; `ChatMessages` derives the same value from its
 * `surfaceVisible` prop because it sits one level above this context.
 */
export function useTileBodyVisible(): boolean {
  const paneVisible = usePaneVisible();
  const tabSelected = useTabBodySelected();
  return paneVisible && tabSelected;
}
