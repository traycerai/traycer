import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostOpenedTabSuppressReason,
  isEpicSurfaceVisible,
  openHostPushedTile,
  setEpicSurfaceVisibility,
  surfaceHostOpenedTab,
  type HostOpenedTabDisposition,
  type HostOpenedTabSource,
} from "../surface-host-opened-tab";
import {
  convertBrowserTabToPip,
  dismissPip,
  getPipSnapshot,
} from "../../pip/pip-store";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
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

function surface(overrides: {
  readonly source: HostOpenedTabSource;
  readonly disposition: HostOpenedTabDisposition;
  readonly openTile: (intent: TileOpenIntent) => void;
}): void {
  surfaceHostOpenedTab({
    epicId: EPIC,
    hostId: HOST,
    sessionId: SESSION,
    tabId: "tab-new",
    ...overrides,
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
    const openTile = vi.fn<(intent: TileOpenIntent) => void>();
    surface({ source: "agent", disposition: "foreground", openTile });
    expect(openTile).not.toHaveBeenCalled();
  });

  it("surfaces a page open even while surfacing is off", () => {
    const openTile = vi.fn<(intent: TileOpenIntent) => void>();
    surface({ source: "page", disposition: "foreground", openTile });
    expect(openTile).toHaveBeenCalledTimes(1);
    expect(openTile.mock.calls[0]?.[0]).toMatchObject({
      target: { epicId: EPIC },
      gesture: "explicit",
      modifiers: null,
      placement: null,
      dedupe: true,
      node: { type: "browser-session", sessionId: SESSION, tabId: "tab-new" },
    });
  });

  it("opens an agent foreground tab as an explicit gesture and a background one as a host push", () => {
    useSettingsStore.setState({ agentTabSurfacing: "surface" });
    const openTile = vi.fn<(intent: TileOpenIntent) => void>();
    surface({ source: "agent", disposition: "foreground", openTile });
    surface({ source: "agent", disposition: "background", openTile });
    expect(openTile.mock.calls.map((call) => call[0].gesture)).toEqual([
      "explicit",
      "host",
    ]);
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
    const openTile = vi.fn<(intent: TileOpenIntent) => void>();
    surface({ source: "page", disposition: "foreground", openTile });
    expect(openTile.mock.calls[0]?.[0].placement).toEqual({
      kind: "tab",
      paneId,
      index: null,
    });
  });

  it("leaves placement to the setting when no pane hosts the session", () => {
    seedCanvasWithTile(makeBlankTileRef());
    const openTile = vi.fn<(intent: TileOpenIntent) => void>();
    surface({ source: "page", disposition: "foreground", openTile });
    expect(openTile.mock.calls[0]?.[0].placement).toBeNull();
  });

  it("suppresses a pip placement behind a manual PiP or a hidden epic", () => {
    useSettingsStore.setState({
      agentTabSurfacing: "surface",
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, browser: "pip" },
    });
    convertBrowserTabToPip({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "other-session",
      tabId: "other-tab",
      origin: "manual",
      onReady: () => {},
      onError: () => {},
    });
    const openTile = vi.fn<(intent: TileOpenIntent) => void>();
    surface({ source: "agent", disposition: "foreground", openTile });
    expect(openTile).not.toHaveBeenCalled();

    dismissPip(EPIC);
    setEpicSurfaceVisibility(EPIC, false);
    expect(isEpicSurfaceVisible(EPIC)).toBe(false);
    surface({ source: "agent", disposition: "foreground", openTile });
    expect(openTile).not.toHaveBeenCalled();

    setEpicSurfaceVisibility(EPIC, true);
    surface({ source: "agent", disposition: "foreground", openTile });
    expect(openTile).toHaveBeenCalledTimes(1);
  });
});

describe("openHostPushedTile", () => {
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
      agentTabSurfacing: "surface",
      tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
    });
  });

  function hostIntent(
    tabId: string,
    placement: TileOpenIntent["placement"],
  ): TileOpenIntent {
    return {
      node: makeBrowserSessionTileRef({
        hostId: HOST,
        sessionId: SESSION,
        tabId,
      }),
      target: { epicId: EPIC },
      gesture: "explicit",
      modifiers: null,
      placement,
      dedupe: true,
      source: "direct_ui",
    };
  }

  it("never mints a header tab for an epic the user has not opened", () => {
    openHostPushedTile(hostIntent("tab-orphan", null));
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });

  it("converts a pip plan with an agent origin, not a manual one", () => {
    useSettingsStore.setState({
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, browser: "pip" },
    });
    seedCanvasWithTile(makeBlankTileRef());
    openHostPushedTile(hostIntent("tab-pip", null));
    expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
      sessionId: SESSION,
      tabId: "tab-pip",
      origin: "agent",
    });
  });

  it("groups an explicit tab placement into the session's pane", () => {
    const paneId = seedCanvasWithTile(
      makeBrowserSessionTileRef({
        hostId: HOST,
        sessionId: SESSION,
        tabId: "tab-source",
      }),
    );
    openHostPushedTile(
      hostIntent("tab-second", { kind: "tab", paneId, index: null }),
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    expect(collectPanes(canvas.root)).toHaveLength(1);
    expect(Object.values(canvas.tilesByInstanceId)).toHaveLength(2);
  });
});
