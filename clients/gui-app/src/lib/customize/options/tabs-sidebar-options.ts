import {
  registerCustomizeOptions,
  type CustomizeMove,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import { recordSettingGesture } from "@/lib/customize/history";
import { getLeftPanelDefinition } from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  groupSidebarPanelWithPrevious,
  moveSidebarPanelDown,
  moveSidebarPanelUp,
  resolveSidebarPanelDrop,
  sidebarPanelRowActions,
  ungroupSidebarPanel,
} from "@/components/settings/panels/layout/sidebar-panel-moves";
import type {
  LeftPanelGroup,
  LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { useEpicLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  NAVIGATOR_RESOURCE_METRICS,
  useSettingsStore,
  type NavigatorResourceMetric,
} from "@/stores/settings/settings-store";

const NAVIGATOR_RESOURCE_METRIC_LABELS: Record<
  NavigatorResourceMetric,
  string
> = {
  cpu: "CPU",
  memory: "Memory",
  processes: "Processes",
};

function panelMoves(panelId: LeftPanelId): ReadonlyArray<CustomizeMove> {
  const groups = useEpicLeftPanelStore.getState().panelGroups;
  const actions = sidebarPanelRowActions(groups, panelId);
  const definition = getLeftPanelDefinition(panelId);
  const write = (label: string, next: ReadonlyArray<LeftPanelGroup>): void => {
    recordSettingGesture(
      "layout.sidebar.panelVisibility",
      label,
      ["panels"],
      () => useEpicLeftPanelStore.getState().applyPanelGroups(next),
    );
  };
  return [
    {
      id: "move-up",
      label: "Move up",
      announcement: `${definition.title} moved up`,
      disabled: !actions.canMoveUp,
      touches: ["panels"],
      analytics: "layout.sidebar.panelVisibility",
      run: () => write("Move up", moveSidebarPanelUp(groups, panelId)),
    },
    {
      id: "move-down",
      label: "Move down",
      announcement: `${definition.title} moved down`,
      disabled: !actions.canMoveDown,
      touches: ["panels"],
      analytics: "layout.sidebar.panelVisibility",
      run: () => write("Move down", moveSidebarPanelDown(groups, panelId)),
    },
    {
      id: "group-with-previous",
      label: "Group with previous",
      announcement: `${definition.title} grouped with the previous panel`,
      disabled: !actions.canGroupWithPrevious,
      touches: ["panels"],
      analytics: "layout.sidebar.panelVisibility",
      run: () =>
        write(
          "Group with previous",
          groupSidebarPanelWithPrevious(groups, panelId),
        ),
    },
    {
      id: "ungroup",
      label: "Ungroup",
      announcement: `${definition.title} ungrouped`,
      disabled: !actions.canUngroup,
      touches: ["panels"],
      analytics: "layout.sidebar.panelVisibility",
      run: () => write("Ungroup", ungroupSidebarPanel(groups, panelId)),
    },
  ];
}

export function registerTabsSidebarCustomizeOptions(): void {
  registerCustomizeOptions("tabs.home", (): CustomizeOptions => {
    const settings = useSettingsStore.getState();
    const homeTabEnabled = settings.homeTabEnabled;
    const homeIsActive =
      homeTabEnabled && useTabsStore.getState().activeItemId === null;
    return {
      state: homeTabEnabled ? "Shown" : "Hidden",
      control: {
        id: "tabs.home",
        label: "Home tab",
        touches: ["settings"],
        analytics: "homeTabEnabled",
        kind: "toggle",
        checked: homeTabEnabled,
        pictures: [],
        change: (checked) => {
          if (!checked && homeIsActive) {
            useCustomizeStore.setState({
              announcement: "Switch to another tab first",
            });
            return;
          }
          recordSettingGesture(
            "homeTabEnabled",
            checked ? "Show Home tab" : "Hide Home tab",
            ["settings"],
            () => useSettingsStore.getState().setHomeTabEnabled(checked),
          );
        },
      },
      moves: [],
      drag: null,
    };
  });

  registerCustomizeOptions("sidebar.panel", (instance): CustomizeOptions => {
    const panelId = instance.tileId as LeftPanelId;
    const groups = useEpicLeftPanelStore.getState().panelGroups;
    const definition = getLeftPanelDefinition(panelId);
    // The registering component (a real tile or `RailGhostTile`) already
    // resolved the real availability context - reusing `instance.ghost`
    // here is what keeps this factory correct for the presence-gated panels
    // without needing that context itself.
    const visible = !instance.ghost;
    return {
      state: visible ? "Visible" : "Hidden",
      control: {
        id: `sidebar.panel.${panelId}`,
        label: definition.title,
        touches: ["panels"],
        analytics: "layout.sidebar.panelVisibility",
        kind: "toggle",
        checked: visible,
        pictures: [],
        change: (checked) => {
          // Always an explicit override, never cleared back to "auto": the
          // presence-gated panels (comments, pull requests) have no way for
          // this factory to know the LIVE presence signal, and a check that
          // silently fell back to auto would immediately revert itself the
          // moment presence disagreed.
          recordSettingGesture(
            "layout.sidebar.panelVisibility",
            checked ? `Show ${definition.title}` : `Hide ${definition.title}`,
            ["panels"],
            () =>
              useEpicLeftPanelStore
                .getState()
                .setPanelVisibilityOverride(panelId, checked),
          );
        },
      },
      moves: panelMoves(panelId),
      drag: {
        group: "sidebar-panels",
        axis: "vertical",
        resolveDrop: (overId) => {
          const overTileId = overIdToPanelId(overId);
          if (overTileId === null) return null;
          // The overlay's drop target is a whole tile, not a boundary edge
          // (there's no "top half vs bottom half" the way the Settings
          // arranger's pointer drag resolves) - dropping onto another tile
          // groups them, exactly as dropping onto a tile does today.
          const next = resolveSidebarPanelDrop(
            groups,
            panelId,
            overTileId,
            "combine",
          );
          if (next === groups) return null;
          return {
            id: "drop",
            label: "Arrange sidebar",
            announcement: `${definition.title} moved`,
            disabled: false,
            touches: ["panels"],
            analytics: "layout.sidebar.panelVisibility",
            run: () => {
              recordSettingGesture(
                "layout.sidebar.panelVisibility",
                "Arrange sidebar",
                ["panels"],
                () => useEpicLeftPanelStore.getState().applyPanelGroups(next),
              );
            },
          };
        },
      },
    };
  });

  registerCustomizeOptions("sidebar.resourceChips", (): CustomizeOptions => {
    const metrics = useSettingsStore.getState().navigatorResourceMetrics;
    return {
      state: metrics.length === 0 ? "Hidden" : "Shown",
      control: {
        id: "sidebar.resourceChips",
        label: "Resource usage",
        touches: ["settings"],
        analytics: "layout.sidebar.resourceMetrics",
        kind: "multi",
        values: metrics,
        lastItemHeld: false,
        moveItem: null,
        options: NAVIGATOR_RESOURCE_METRICS.map((metric) => ({
          value: metric,
          label: NAVIGATOR_RESOURCE_METRIC_LABELS[metric],
          picture: null,
          override: {},
        })),
        change: (values) => {
          const next = NAVIGATOR_RESOURCE_METRICS.filter((metric) =>
            values.includes(metric),
          );
          recordSettingGesture(
            "layout.sidebar.resourceMetrics",
            "Change resource metrics",
            ["settings"],
            () => useSettingsStore.getState().setNavigatorResourceMetrics(next),
          );
        },
      },
      moves: [],
      drag: null,
    };
  });
}

function overIdToPanelId(overId: string): LeftPanelId | null {
  const separatorIndex = overId.lastIndexOf(":");
  if (separatorIndex === -1) return null;
  return overId.slice(separatorIndex + 1) as LeftPanelId;
}
