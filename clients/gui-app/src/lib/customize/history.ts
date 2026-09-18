import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import type { AnalyticsSetting } from "@/lib/analytics";
import type { LayoutSettingsKey } from "@/lib/layout-overrides";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  useLayoutStore,
  type ComposerLayoutPreferences,
  type StatusBarLayoutPreferences,
} from "@/stores/settings/layout-store";
import {
  useSettingsStore,
  type SettingsState,
} from "@/stores/settings/settings-store";
import {
  useLeftPanelStore,
  type LeftPanelGroup,
  type PanelVisibilityOverrideById,
} from "@/stores/epics/left-panel-store";

// The header's resource visibility is a layout preference too, although it is
// intentionally outside the picture override seam.
type HistorySettingsKey = LayoutSettingsKey | "showGlobalResourceMonitor";
export interface LayoutPatch {
  readonly statusBar?: StatusBarLayoutPreferences;
  readonly composer?: ComposerLayoutPreferences;
  readonly settings?: Partial<Pick<SettingsState, HistorySettingsKey>>;
  readonly panels?: {
    readonly groups: ReadonlyArray<LeftPanelGroup>;
    readonly overrides: PanelVisibilityOverrideById;
  };
}
export interface HistoryEntry {
  readonly label: string;
  readonly before: LayoutPatch;
  readonly after: LayoutPatch;
}
export const ALL_LAYOUT_SLICES: ReadonlyArray<keyof LayoutPatch> = [
  "statusBar",
  "composer",
  "settings",
  "panels",
];
const SETTINGS_KEYS: ReadonlyArray<HistorySettingsKey> = [
  "pinContextUsageBreakdown",
  "pinnedContextBreakdownFields",
  "pinnedContextBreakdownOrder",
  "contextIndicatorStyle",
  "chatTurnMinimapSide",
  "navigatorResourceMetrics",
  "homeTabEnabled",
  "showGlobalResourceMonitor",
];
let editorWriting = false;

function snapshot(touches: ReadonlyArray<keyof LayoutPatch>): LayoutPatch {
  const layout = useLayoutStore.getState();
  const settings = useSettingsStore.getState();
  const panels = useLeftPanelStore.getState();
  return structuredClone({
    ...(touches.includes("statusBar") ? { statusBar: layout.statusBar } : {}),
    ...(touches.includes("composer") ? { composer: layout.composer } : {}),
    ...(touches.includes("settings")
      ? {
          settings: Object.fromEntries(
            SETTINGS_KEYS.map((key) => [key, settings[key]]),
          ),
        }
      : {}),
    ...(touches.includes("panels")
      ? {
          panels: {
            groups: panels.panelGroups,
            overrides: panels.panelVisibilityOverrideById,
          },
        }
      : {}),
  });
}

export function applyPatch(patch: LayoutPatch): void {
  const layout = useLayoutStore.getState();
  const settings = useSettingsStore.getState();
  if (patch.statusBar) layout.setStatusBarPreferences(patch.statusBar);
  if (patch.composer) layout.setComposerPreferences(patch.composer);
  const s = patch.settings;
  if (s) {
    if (s.pinContextUsageBreakdown !== undefined)
      settings.setPinContextUsageBreakdown(s.pinContextUsageBreakdown);
    if (s.pinnedContextBreakdownFields !== undefined)
      settings.setPinnedContextBreakdownFields(s.pinnedContextBreakdownFields);
    if (s.pinnedContextBreakdownOrder !== undefined)
      settings.setPinnedContextBreakdownOrder(s.pinnedContextBreakdownOrder);
    if (s.contextIndicatorStyle !== undefined)
      settings.setContextIndicatorStyle(s.contextIndicatorStyle);
    if (s.chatTurnMinimapSide !== undefined)
      settings.setMinimapSide(s.chatTurnMinimapSide);
    if (s.navigatorResourceMetrics !== undefined)
      settings.setNavigatorResourceMetrics(s.navigatorResourceMetrics);
    if (s.homeTabEnabled !== undefined)
      settings.setHomeTabEnabled(s.homeTabEnabled);
    if (s.showGlobalResourceMonitor !== undefined)
      settings.setShowGlobalResourceMonitor(s.showGlobalResourceMonitor);
  }
  if (patch.panels) {
    useLeftPanelStore.getState().applyPanelGroups(patch.panels.groups);
    useLeftPanelStore
      .getState()
      .setPanelVisibilityOverrides(patch.panels.overrides);
  }
}

export function recordGesture(
  label: string,
  touches: ReadonlyArray<keyof LayoutPatch>,
  mutate: () => void,
): void {
  if (!useCustomizeStore.getState().session) return;
  const before = snapshot(touches);
  editorWriting = true;
  try {
    mutate();
    if (!useCustomizeStore.getState().session) return;
    const after = snapshot(touches);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    useCustomizeStore.setState((state) => ({
      history: {
        past: [...state.history.past, { label, before, after }],
        future: [],
      },
      announcement: label,
    }));
  } catch (error) {
    applyPatch(before);
    throw error;
  } finally {
    editorWriting = false;
  }
}

export function recordSettingGesture(
  setting: AnalyticsSetting,
  label: string,
  touches: ReadonlyArray<keyof LayoutPatch>,
  mutate: () => void,
): void {
  const previous = useCustomizeStore.getState().history;
  recordGesture(label, touches, mutate);
  if (useCustomizeStore.getState().history !== previous)
    trackLayoutSetting(setting);
}

function travel(direction: "undo" | "redo"): void {
  if (!useCustomizeStore.getState().session) return;
  const { history } = useCustomizeStore.getState();
  const source = direction === "undo" ? history.past : history.future;
  const entry = source.at(-1);
  if (!entry) return;
  editorWriting = true;
  try {
    applyPatch(direction === "undo" ? entry.before : entry.after);
    if (!useCustomizeStore.getState().session) return;
    useCustomizeStore.setState({
      history:
        direction === "undo"
          ? {
              past: history.past.slice(0, -1),
              future: [...history.future, entry],
            }
          : {
              past: [...history.past, entry],
              future: history.future.slice(0, -1),
            },
      announcement: `${direction === "undo" ? "Undid" : "Redid"}: ${entry.label}`,
    });
  } finally {
    editorWriting = false;
  }
}
export function undo(): void {
  travel("undo");
}
export function redo(): void {
  travel("redo");
}

export function watchExternalLayoutWrites(): () => void {
  let previous = JSON.stringify(snapshot(ALL_LAYOUT_SLICES));
  const changed = () => {
    const next = JSON.stringify(snapshot(ALL_LAYOUT_SLICES));
    if (next !== previous && !editorWriting)
      useCustomizeStore.setState({ history: { past: [], future: [] } });
    previous = next;
  };
  const unsubscribes = [
    useLayoutStore.subscribe(changed),
    useSettingsStore.subscribe(changed),
    useLeftPanelStore.subscribe(changed),
  ];
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}
