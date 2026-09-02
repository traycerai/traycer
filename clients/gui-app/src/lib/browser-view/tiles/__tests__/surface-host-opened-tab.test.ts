import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserTabOpenedSource } from "@traycer/protocol/host/browser/contracts";
import {
  hostOpenedTabSuppressReason,
  isEpicSurfaceVisible,
  setEpicSurfaceVisibility,
  surfaceHostOpenedTab,
} from "../surface-host-opened-tab";
import {
  convertBrowserTabToPip,
  dismissPip,
  getPipSnapshot,
} from "../../pip/pip-store";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes, type TilePane } from "@/stores/epics/canvas/tile-tree";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import {
  DEFAULT_TILE_PLACEMENT_SETTINGS,
  useSettingsStore,
} from "@/stores/settings/settings-store";

const EPIC = "epic-host-opened";
const HOST = "host-1";
const SESSION = "session-a";
const VIEW_TAB_ID = "view-host-opened";

function seedCanvasWithTile(tile: EpicCanvasTileRef): string {
  const canvas = createSingleTileCanvas(tile);
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected a pane");
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: EPIC, name: "Surfacing" },
    },
    openTabOrder: [VIEW_TAB_ID],
    activeTabId: VIEW_TAB_ID,
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
  return pane.id;
}

function canvas(): EpicCanvasState {
  const state = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (state === undefined) throw new Error("expected a canvas");
  return state;
}

function panes(): readonly TilePane[] {
  const root = canvas().root;
  if (root === null) throw new Error("expected a root");
  return collectPanes(root);
}

function tileCount(): number {
  return Object.keys(canvas().tilesByInstanceId).length;
}

function surface(overrides: {
  readonly source: BrowserTabOpenedSource;
  readonly tabId?: string;
}): void {
  surfaceHostOpenedTab({
    epicId: EPIC,
    hostId: HOST,
    sessionId: SESSION,
    tabId: overrides.tabId ?? "tab-new",
    source: overrides.source,
  });
}

describe("hostOpenedTabSuppressReason", () => {
  it("gates agent opens on the setting and never page opens", () => {
    const base = {
      surfacing: "off",
      browserPlacement: "split",
      epicVisible: true,
      manualPipActive: false,
    } as const;
    expect(hostOpenedTabSuppressReason({ ...base, source: "agent" })).toBe(
      "mode-off",
    );
    expect(hostOpenedTabSuppressReason({ ...base, source: "page" })).toBeNull();
  });

  it("keeps the pip suppression rules for every source", () => {
    const base = {
      surfacing: "surface",
      browserPlacement: "pip",
      source: "page",
    } as const;
    expect(
      hostOpenedTabSuppressReason({
        ...base,
        epicVisible: true,
        manualPipActive: true,
      }),
    ).toBe("manual-pip-active");
    expect(
      hostOpenedTabSuppressReason({
        ...base,
        epicVisible: false,
        manualPipActive: false,
      }),
    ).toBe("pip-epic-hidden");
    expect(
      hostOpenedTabSuppressReason({
        ...base,
        epicVisible: true,
        manualPipActive: false,
      }),
    ).toBeNull();
  });

  it("places a tile in a hidden epic past a manual PiP for any other placement", () => {
    expect(
      hostOpenedTabSuppressReason({
        source: "agent",
        surfacing: "surface",
        browserPlacement: "split",
        epicVisible: false,
        manualPipActive: true,
      }),
    ).toBeNull();
  });
});

describe("surfaceHostOpenedTab", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({
      canvasByTabId: {},
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
    });
    dismissPip(EPIC);
    setEpicSurfaceVisibility(EPIC, true);
    useSettingsStore.setState({
      agentTabSurfacing: "off",
      tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
    });
  });

  it("no-ops for an agent open while surfacing is off", () => {
    seedCanvasWithTile(makeBlankTileRef());
    surface({ source: "agent" });
    expect(tileCount()).toBe(1);
  });

  it("surfaces a page open even while surfacing is off", () => {
    seedCanvasWithTile(makeBlankTileRef());
    surface({ source: "page" });
    expect(tileCount()).toBe(2);
  });

  it("never mints a header tab for an epic the user has not opened", () => {
    surface({ source: "page" });
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });

  it("places into the pane already hosting the session", () => {
    useSettingsStore.setState({ agentTabSurfacing: "surface" });
    const paneId = seedCanvasWithTile(
      makeBrowserSessionTileRef({
        hostId: HOST,
        sessionId: SESSION,
        tabId: "tab-source",
      }),
    );

    surface({ source: "agent" });

    // Grouped beside its sibling rather than splitting off a browser pane.
    expect(panes()).toHaveLength(1);
    expect(panes()[0]?.id).toBe(paneId);
    expect(tileCount()).toBe(2);
  });

  it("splits right into a seeded canvas when no pane hosts the session", () => {
    useSettingsStore.setState({ agentTabSurfacing: "surface" });
    const paneId = seedCanvasWithTile(makeBlankTileRef());

    surface({ source: "agent" });

    // Browser category default is `split` (C3), so the tab lands in a NEW
    // pane to the right, and that pane becomes the active one.
    const after = panes();
    expect(after).toHaveLength(2);
    expect(after[0]?.id).toBe(paneId);
    expect(canvas().activePaneId).toBe(after[1]?.id);
    expect(after[1]?.tabInstanceIds).toHaveLength(1);
  });

  it("floats a pip placement on the AGENT's behalf, replacing an earlier agent float", () => {
    useSettingsStore.setState({
      agentTabSurfacing: "surface",
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, browser: "pip" },
    });
    seedCanvasWithTile(makeBlankTileRef());
    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: SESSION,
      tabId: "tab-earlier",
      origin: "agent",
      onReady: () => {},
      onError: () => {},
    });

    surface({ source: "agent", tabId: "tab-pip" });

    // An `agent` float is replaced latest-wins; a `manual` one never is.
    expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
      sessionId: SESSION,
      tabId: "tab-pip",
      origin: "agent",
    });
  });

  it("suppresses a pip placement behind a manual PiP or a hidden epic", () => {
    useSettingsStore.setState({
      agentTabSurfacing: "surface",
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, browser: "pip" },
    });
    seedCanvasWithTile(makeBlankTileRef());
    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "other-session",
      tabId: "other-tab",
      origin: "manual",
      onReady: () => {},
      onError: () => {},
    });

    surface({ source: "agent" });
    expect(tileCount()).toBe(1);

    dismissPip(EPIC);
    setEpicSurfaceVisibility(EPIC, false);
    expect(isEpicSurfaceVisible(EPIC)).toBe(false);
    surface({ source: "agent" });
    expect(tileCount()).toBe(1);
    expect(getPipSnapshot(EPIC).pendingTarget).toBeNull();

    setEpicSurfaceVisibility(EPIC, true);
    surface({ source: "agent" });
    expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
      tabId: "tab-new",
      origin: "agent",
    });
  });

  it("lands a tab, not a suppressed float, when a pane already hosts the session (R4)", () => {
    useSettingsStore.setState({
      agentTabSurfacing: "surface",
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, browser: "pip" },
    });
    const paneId = seedCanvasWithTile(
      makeBrowserSessionTileRef({
        hostId: HOST,
        sessionId: SESSION,
        tabId: "tab-source",
      }),
    );
    // Both pip suppression conditions hold - and neither applies, because the
    // effective placement is a TAB in the session's own pane.
    setEpicSurfaceVisibility(EPIC, false);
    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "other-session",
      tabId: "other-tab",
      origin: "manual",
      onReady: () => {},
      onError: () => {},
    });

    surface({ source: "agent" });

    expect(panes()).toHaveLength(1);
    expect(panes()[0]?.id).toBe(paneId);
    expect(tileCount()).toBe(2);
  });
});
