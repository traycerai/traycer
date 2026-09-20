import { useShallow } from "zustand/react/shallow";
import {
  useComposerLayout,
  useLayoutSetting,
  useStatusBarLayout,
} from "@/lib/layout-overrides";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

/** One subscription boundary for forms/labels spanning the layout slices. */
export function useCustomizeLayout(): void {
  useComposerLayout();
  useStatusBarLayout();
  useLayoutSetting("pinContextUsageBreakdown");
  useLayoutSetting("pinnedContextBreakdownFields");
  useLayoutSetting("pinnedContextBreakdownOrder");
  useLayoutSetting("contextIndicatorStyle");
  useLayoutSetting("chatTurnMinimapSide");
  useLayoutSetting("navigatorResourceMetrics");
  useLayoutSetting("homeTabEnabled");
  useSettingsStore((state) => state.showGlobalResourceMonitor);
  useLeftPanelStore(
    useShallow((state) => [
      state.panelGroups,
      state.panelVisibilityOverrideById,
    ]),
  );
}
