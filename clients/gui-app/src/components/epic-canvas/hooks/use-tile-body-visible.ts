import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";

/** Mounted-but-concealed keep-alive bodies (`display:none`) read `false`. */
export function useTileBodyVisible(): boolean {
  const paneVisible = usePaneVisible();
  const tabSelected = useTabBodySelected();
  return paneVisible && tabSelected;
}
