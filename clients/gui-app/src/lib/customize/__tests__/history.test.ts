import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_LAYOUT_SLICES,
  recordGesture,
  undo,
  redo,
  watchExternalLayoutWrites,
} from "@/lib/customize/history";
import { applyLayoutPreset } from "@/lib/layout-presets";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_MINIMAP_SIDE,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({
    pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    pinnedContextBreakdownOrder: DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
    navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
    homeTabEnabled: false,
    showGlobalResourceMonitor: true,
  });
  useLeftPanelStore.getState().applyPanelGroups(DEFAULT_LEFT_PANEL_GROUPS);
  useLeftPanelStore.getState().clearPanelVisibilityOverrides();
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    history: { past: [], future: [] },
  });
}

let stopWatching: (() => void) | null = null;

beforeEach(resetStores);
afterEach(() => {
  stopWatching?.();
  stopWatching = null;
});

describe("recordGesture + undo across every touched slice", () => {
  it("recording a gesture around applyLayoutPreset yields exactly one history entry", () => {
    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );

    const { history } = useCustomizeStore.getState();
    expect(history.past).toHaveLength(1);
    expect(history.future).toHaveLength(0);
    expect(history.past[0]?.label).toBe("Compact");
  });

  it("undo restores every touched slice, including checked accounts and rail groups", () => {
    const beforeStatusBar = useLayoutStore.getState().statusBar;
    const beforeComposer = useLayoutStore.getState().composer;
    const beforeSettings = useSettingsStore.getState().contextIndicatorStyle;
    const beforeGroups = useLeftPanelStore.getState().panelGroups;

    recordGesture("Compact", ALL_LAYOUT_SLICES, () => {
      applyLayoutPreset("compact");
      // Checked accounts: which host profiles the strip draws, per provider.
      useLayoutStore.getState().setStatusBarPreferences({
        ...useLayoutStore.getState().statusBar,
        rateLimits: {
          ...useLayoutStore.getState().statusBar.rateLimits,
          shownProfiles: { "host-a": { codex: ["profile-1"] } },
        },
      });
      // Rail groups: reorder + collapse two groups into one.
      useLeftPanelStore
        .getState()
        .applyPanelGroups([
          { panelIds: ["terminals", "chats", "artifacts"] },
          { panelIds: ["browsers"] },
        ]);
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverrides({ "git-diff": false });
    });

    // Sanity: the gesture actually changed things before we undo them.
    expect(useLeftPanelStore.getState().panelGroups).not.toEqual(beforeGroups);

    undo();

    expect(useLayoutStore.getState().statusBar).toEqual(beforeStatusBar);
    expect(useLayoutStore.getState().composer).toEqual(beforeComposer);
    expect(useSettingsStore.getState().contextIndicatorStyle).toBe(
      beforeSettings,
    );
    expect(useLeftPanelStore.getState().panelGroups).toEqual(beforeGroups);
    expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual(
      {},
    );

    const { history } = useCustomizeStore.getState();
    expect(history.past).toHaveLength(0);
    expect(history.future).toHaveLength(1);
  });

  it("redo replays the gesture after an undo", () => {
    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );
    const afterGesture = useLayoutStore.getState().statusBar;

    undo();
    redo();

    expect(useLayoutStore.getState().statusBar).toEqual(afterGesture);
    const { history } = useCustomizeStore.getState();
    expect(history.past).toHaveLength(1);
    expect(history.future).toHaveLength(0);
  });

  it("a mutate that produces no actual change records nothing", () => {
    recordGesture("No-op", ALL_LAYOUT_SLICES, () => {
      // Sets the same values it already has.
      useLayoutStore
        .getState()
        .setStatusBarPreferences(useLayoutStore.getState().statusBar);
    });

    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });

  it("recordGesture is a no-op with no live session", () => {
    useCustomizeStore.setState({ session: null });

    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );

    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });
});

describe("external writes vs. writes made inside a gesture", () => {
  it("does not clobber history for the store writes a gesture makes on itself", () => {
    stopWatching = watchExternalLayoutWrites();

    // applyLayoutPreset writes statusBar, composer and settings across three
    // separate store setState calls; each one fires the external-write
    // watcher. The `editorWriting` guard must keep every one of those from
    // being mistaken for an external change and clearing the history it is
    // itself in the middle of building.
    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );

    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
  });

  it("an external write (outside any gesture) clears history", () => {
    stopWatching = watchExternalLayoutWrites();
    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);

    useLayoutStore.getState().setStatusBarPlacement("header");

    expect(useCustomizeStore.getState().history).toEqual({
      past: [],
      future: [],
    });
  });

  it("an external write that does not change the snapshot leaves history alone", () => {
    stopWatching = watchExternalLayoutWrites();
    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );

    // Notify subscribers with the same value (bypassing the setter's own
    // no-op guard): the watcher's JSON comparison, not the setter, is what
    // must keep this from clearing history.
    useLayoutStore.setState({ statusBar: useLayoutStore.getState().statusBar });

    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
  });

  it("stopping the watcher stops it from reacting to further external writes", () => {
    const stop = watchExternalLayoutWrites();
    recordGesture("Compact", ALL_LAYOUT_SLICES, () =>
      applyLayoutPreset("compact"),
    );
    stop();

    useLayoutStore.getState().setStatusBarPlacement("header");

    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
  });
});
