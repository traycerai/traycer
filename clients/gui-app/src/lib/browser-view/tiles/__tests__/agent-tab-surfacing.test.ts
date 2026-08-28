import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideAgentTabDisposition,
  findPaneIdHostingSessionTile,
  isEpicSurfaceVisible,
  isManualPipActive,
  placeAgentTabTile,
  setEpicSurfaceVisibility,
  surfaceAgentTab,
} from "../agent-tab-surfacing";
import {
  convertBrowserTabToPip,
  dismissPip,
  getPipSnapshot,
} from "../../pip/pip-store";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";

const EPIC = "epic-surface-1";
const HOST = "host-1";
const VIEW_TAB_ID = "view-agent-tab-surfacing";

function agentTabFixture(overrides: { readonly tabId: string }) {
  return {
    epicId: EPIC,
    hostId: HOST,
    sessionId: "session-a",
    tabId: overrides.tabId,
  };
}

function seedCanvasWithTile(tile: EpicCanvasTileRef): string {
  const canvas = createSingleTileCanvas(tile);
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected a pane");
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: EPIC, name: "Surfacing" },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
  return pane.id;
}

describe("decideAgentTabDisposition", () => {
  it("suppresses with mode-off regardless of visibility or pip state", () => {
    expect(
      decideAgentTabDisposition({
        mode: "off",
        epicVisible: true,
        manualPipActive: false,
      }),
    ).toEqual({ action: "suppress", suppressReason: "mode-off" });
  });

  it("places a tile even in hidden epics and past a manual PiP", () => {
    expect(
      decideAgentTabDisposition({
        mode: "tile",
        epicVisible: false,
        manualPipActive: true,
      }),
    ).toEqual({ action: "tile", suppressReason: null });
  });

  it("never floats over a manual PiP", () => {
    expect(
      decideAgentTabDisposition({
        mode: "pip",
        epicVisible: true,
        manualPipActive: true,
      }),
    ).toEqual({ action: "suppress", suppressReason: "manual-pip-active" });
  });

  it("does not arm PiP for a hidden epic", () => {
    expect(
      decideAgentTabDisposition({
        mode: "pip",
        epicVisible: false,
        manualPipActive: false,
      }),
    ).toEqual({ action: "suppress", suppressReason: "pip-epic-hidden" });
  });

  it("floats when pip mode, visible epic, and no manual PiP", () => {
    expect(
      decideAgentTabDisposition({
        mode: "pip",
        epicVisible: true,
        manualPipActive: false,
      }),
    ).toEqual({ action: "float", suppressReason: null });
  });
});

describe("isManualPipActive", () => {
  beforeEach(() => {
    dismissPip(EPIC);
  });

  it("is false with no PiP and true only for manual conversions", () => {
    expect(isManualPipActive(EPIC)).toBe(false);

    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-a",
      tabId: "tab-a1",
      origin: "manual",
      onReady: () => {},
      onError: () => {},
    });
    expect(isManualPipActive(EPIC)).toBe(true);
    dismissPip(EPIC);

    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-a",
      tabId: "tab-a1",
      origin: "agent",
      onReady: () => {},
      onError: () => {},
    });
    expect(getPipSnapshot(EPIC).pendingTarget?.origin).toBe("agent");
    expect(isManualPipActive(EPIC)).toBe(false);
  });
});

describe("canvas placement", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
    dismissPip(EPIC);
    setEpicSurfaceVisibility(EPIC, true);
  });

  afterEach(() => {
    setEpicSurfaceVisibility(EPIC, false);
  });

  it("groups a same-session electron open as a tab instead of splitting", () => {
    const sourceTile = makeBrowserSessionTileRef({
      hostId: HOST,
      sessionId: "session-shared",
      tabId: "tab-source",
    });
    seedCanvasWithTile(sourceTile);

    const placed = placeAgentTabTile({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-shared",
      tabId: "tab-second",
    });
    expect(placed).toBe(true);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    expect(collectPanes(canvas.root)).toHaveLength(1);
    expect(
      findPaneIdHostingSessionTile(canvas, "session-shared"),
    ).not.toBeNull();
  });

  it("splits right of the anchor pane for a brand-new session", () => {
    const sourceTile = makeBlankTileRef();
    const anchorPaneId = seedCanvasWithTile(sourceTile);

    const placed = placeAgentTabTile({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-fresh",
      tabId: "tab-fresh",
    });
    expect(placed).toBe(true);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    const panes = collectPanes(canvas.root);
    expect(panes).toHaveLength(2);
    const hostingPaneId = findPaneIdHostingSessionTile(canvas, "session-fresh");
    expect(hostingPaneId).not.toBeNull();
    expect(hostingPaneId).not.toBe(anchorPaneId);
    const activePane = panes.find((pane) => pane.id === hostingPaneId);
    expect(activePane?.id).toBe(canvas.activePaneId);
  });

  it("places a read-only session tile split beside the active pane for headless opens", () => {
    seedCanvasWithTile(makeBlankTileRef());

    const placed = placeAgentTabTile({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-headless",
      tabId: "tab-h1",
    });
    expect(placed).toBe(true);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    const panes = collectPanes(canvas.root);
    expect(panes).toHaveLength(2);
    const hostingPaneId = findPaneIdHostingSessionTile(
      canvas,
      "session-headless",
    );
    expect(hostingPaneId).not.toBeNull();
    const hostedInstanceId = panes
      .find((pane) => pane.id === hostingPaneId)
      ?.tabInstanceIds.find(
        (instanceId) =>
          canvas.tilesByInstanceId[instanceId]?.type === "browser-session",
      );
    expect(hostedInstanceId).toBeDefined();
  });
});

describe("surfaceAgentTab", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
    dismissPip(EPIC);
    useSettingsStore.setState({ agentTabSurfacingMode: "off" });
  });

  it("suppresses in off mode", () => {
    surfaceAgentTab(agentTabFixture({ tabId: "tab-x" }));
    expect(getPipSnapshot(EPIC).target).toBeNull();
    expect(getPipSnapshot(EPIC).pendingTarget).toBeNull();
    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    expect(canvas === undefined || canvas.root === null).toBe(true);
  });

  it("arms a pending agent PiP in pip mode on a visible epic", () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "pip" });
    setEpicSurfaceVisibility(EPIC, true);
    surfaceAgentTab(agentTabFixture({ tabId: "tab-pip" }));
    expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
      sessionId: "session-a",
      tabId: "tab-pip",
      origin: "agent",
    });
    setEpicSurfaceVisibility(EPIC, false);
  });

  it("skips the float when a manual PiP owns the overlay", () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "pip" });
    setEpicSurfaceVisibility(EPIC, true);
    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "other-session",
      tabId: "other-tab",
      origin: "manual",
      onReady: () => {},
      onError: () => {},
    });
    surfaceAgentTab(agentTabFixture({ tabId: "tab-respected" }));
    expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
      sessionId: "other-session",
    });
    setEpicSurfaceVisibility(EPIC, false);
  });

  it("places a canvas tile in tile mode even for hidden epics", () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "tile" });
    setEpicSurfaceVisibility(EPIC, false);
    seedCanvasWithTile(makeBlankTileRef());
    surfaceAgentTab(agentTabFixture({ tabId: "tab-tiled" }));
    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    expect(collectPanes(canvas.root)).toHaveLength(2);
    expect(isEpicSurfaceVisible(EPIC)).toBe(false);
  });
});
