import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { registerTabsSidebarCustomizeOptions } from "@/lib/customize/options/tabs-sidebar-options";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useEpicLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

registerTabsSidebarCustomizeOptions();

function startSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
}

function instanceFor(panelId: LeftPanelId, ghost: boolean): HotspotInstance {
  return {
    key: `sidebar.panel@shell:${panelId}`,
    settingId: "sidebar.panel",
    sceneId: "shell",
    tileId: panelId,
    node: document.createElement("div"),
    ghost,
    condition: ghost ? "Hidden from the sidebar" : null,
  };
}

beforeEach(() => {
  useEpicLeftPanelStore.setState({
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    panelVisibilityOverrideById: {},
  });
  startSession();
});
afterEach(cleanup);

describe("sidebar.panel option", () => {
  it("reports a visible tile's state from the registering instance", () => {
    const options = getCustomizeOptions(instanceFor("chats", false));
    expect(options?.state).toBe("Visible");
    expect(options?.control?.kind).toBe("toggle");
  });

  it("hiding a visible panel writes an explicit override", () => {
    const options = getCustomizeOptions(instanceFor("chats", false));
    act(() => {
      if (options?.control?.kind === "toggle") options.control.change(false);
    });
    expect(
      useEpicLeftPanelStore.getState().panelVisibilityOverrideById.chats,
    ).toBe(false);
  });

  it("showing a ghost tile writes an explicit override, never auto", () => {
    const options = getCustomizeOptions(instanceFor("comments", true));
    act(() => {
      if (options?.control?.kind === "toggle") options.control.change(true);
    });
    expect(
      useEpicLeftPanelStore.getState().panelVisibilityOverrideById.comments,
    ).toBe(true);
  });

  it("Move down moves a lone tile past its neighbour group, Move up moves it back", () => {
    // "terminals" is alone in its group, so Move down/up here moves the whole
    // group past its neighbour rather than reordering within a group first.
    const before = getCustomizeOptions(instanceFor("terminals", false));
    const moveDown = before?.moves.find((move) => move.id === "move-down");
    expect(moveDown?.disabled).toBe(false);
    act(() => moveDown?.run());
    expect(
      useEpicLeftPanelStore.getState().panelGroups.map((g) => g.panelIds),
    ).toEqual([
      ["chats", "artifacts"],
      ["browsers"],
      ["terminals"],
      ["git-diff"],
      ["pull-requests"],
      ["file-tree"],
      ["sharing"],
      ["comments"],
    ]);

    const after = getCustomizeOptions(instanceFor("terminals", false));
    const moveUp = after?.moves.find((move) => move.id === "move-up");
    act(() => moveUp?.run());
    expect(useEpicLeftPanelStore.getState().panelGroups).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
  });

  it("Group with previous tabs a panel with its neighbour, Ungroup splits it back out", () => {
    const before = getCustomizeOptions(instanceFor("terminals", false));
    const group = before?.moves.find(
      (move) => move.id === "group-with-previous",
    );
    expect(group?.disabled).toBe(false);
    act(() => group?.run());
    expect(useEpicLeftPanelStore.getState().panelGroups[0]?.panelIds).toEqual([
      "chats",
      "artifacts",
      "terminals",
    ]);

    const after = getCustomizeOptions(instanceFor("terminals", false));
    const ungroup = after?.moves.find((move) => move.id === "ungroup");
    expect(ungroup?.disabled).toBe(false);
    act(() => ungroup?.run());
    expect(useEpicLeftPanelStore.getState().panelGroups).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
  });

  it("dropping a tile onto another combines them via the shared resolver", () => {
    const dragging = getCustomizeOptions(instanceFor("browsers", false));
    const move = dragging?.drag?.resolveDrop("sidebar.panel@shell:terminals");
    expect(move).not.toBeNull();
    act(() => {
      if (move !== null && move !== undefined && "run" in move) move.run();
    });
    expect(useEpicLeftPanelStore.getState().panelGroups).toContainEqual({
      panelIds: ["terminals", "browsers"],
    });
  });

  it("resolveDrop is a no-op when the target id cannot be parsed", () => {
    const dragging = getCustomizeOptions(instanceFor("browsers", false));
    expect(dragging?.drag?.resolveDrop("not-an-instance-key")).toBeNull();
  });
});

describe("sidebar.resourceChips option", () => {
  const instance: HotspotInstance = {
    key: "sidebar.resourceChips@shell:-",
    settingId: "sidebar.resourceChips",
    sceneId: "shell",
    tileId: null,
    node: document.createElement("div"),
    ghost: true,
    condition: "No metrics selected",
  };

  beforeEach(() => {
    useSettingsStore.setState({ navigatorResourceMetrics: [] });
  });

  it("reports Hidden with no metrics selected", () => {
    const options = getCustomizeOptions(instance);
    expect(options?.state).toBe("Hidden");
    expect(options?.control?.kind).toBe("multi");
  });

  it("reports Shown once a metric is selected", () => {
    useSettingsStore.setState({ navigatorResourceMetrics: ["cpu"] });
    expect(getCustomizeOptions(instance)?.state).toBe("Shown");
  });

  it("adding a metric writes through the store", () => {
    const options = getCustomizeOptions(instance);
    act(() => {
      if (options?.control?.kind === "multi") options.control.change(["cpu"]);
    });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
    ]);
  });

  it("clearing every metric is allowed, hiding the chip", () => {
    useSettingsStore.setState({ navigatorResourceMetrics: ["cpu"] });
    const options = getCustomizeOptions(instance);
    act(() => {
      if (options?.control?.kind === "multi") options.control.change([]);
    });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
  });
});
