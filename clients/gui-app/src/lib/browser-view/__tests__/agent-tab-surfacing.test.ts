import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  collectNewAgentTabsFromSessionFrame,
  decideAgentTabDisposition,
  findPaneIdHostingSessionTile,
  forgetSeenAgentTabsForSession,
  isEpicSurfaceVisible,
  isManualPipActive,
  placeAgentElectronTile,
  placeHeadlessAgentSessionTile,
  rememberElectronTabCreate,
  resetAgentTabSurfacingForTests,
  setEpicSurfaceVisibility,
  surfaceAgentTabsFromSessionFrame,
} from "../agent-tab-surfacing";
import {
  convertBrowserTabToPip,
  dismissPip,
  getPipSnapshot,
} from "../pip-store";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  makeBrowserSessionTileRef,
  makeBrowserTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const EPIC = "epic-surface-1";
const HOST = "host-1";
const VIEW_TAB_ID = "view-agent-tab-surfacing";

function agentSessionFixture(overrides?: {
  readonly sessionId?: string;
  readonly agentRunId?: string | null;
}): BrowserSessionInfo {
  return {
    sessionId: overrides?.sessionId ?? "session-a",
    epicId: EPIC,
    hostId: HOST,
    profile: "isolated",
    name: "Agent browser",
    createdBy: {
      chatId: "chat-1",
      agentRunId:
        overrides?.agentRunId === undefined ? "agent-1" : overrides.agentRunId,
    },
    createdAt: 0,
    lastActivityAt: 0,
    runtime: { kind: "electron", revision: 0 },
    tabs: [
      {
        tabId: "tab-a1",
        url: "https://example.com/a",
        originTier: "external",
        status: "ready",
        title: null,
        viewed: false,
        drivenBy: [],
      },
    ],
  };
}

function seedCanvasWithTile(
  tile:
    | ReturnType<typeof makeBrowserTileRef>
    | ReturnType<typeof makeBrowserSessionTileRef>,
): string {
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

describe("collectNewAgentTabsFromSessionFrame", () => {
  beforeEach(() => {
    resetAgentTabSurfacingForTests();
  });

  it("seeds on first sight without reporting existing tabs", () => {
    expect(collectNewAgentTabsFromSessionFrame(agentSessionFixture())).toEqual(
      [],
    );
  });

  it("reports only genuinely new tabs of an agent-created session", () => {
    collectNewAgentTabsFromSessionFrame(agentSessionFixture());
    const updated = agentSessionFixture();
    const next = {
      ...updated,
      tabs: [
        ...updated.tabs,
        {
          tabId: "tab-a2",
          url: "https://example.com/b",
          originTier: "external" as const,
          status: "provisioning" as const,
          title: null,
          viewed: false,
          drivenBy: [],
        },
      ],
    };
    expect(collectNewAgentTabsFromSessionFrame(next)).toEqual([
      { tabId: "tab-a2", url: "https://example.com/b" },
    ]);
    // Replay of the same frame must not re-report.
    expect(collectNewAgentTabsFromSessionFrame(next)).toEqual([]);
  });

  it("does not re-surface a tab whose targeted Electron create owns presentation", () => {
    collectNewAgentTabsFromSessionFrame(agentSessionFixture());
    rememberElectronTabCreate("session-a", "tab-a2");
    const updated = agentSessionFixture();

    expect(
      collectNewAgentTabsFromSessionFrame({
        ...updated,
        tabs: [
          ...updated.tabs,
          {
            ...updated.tabs[0],
            tabId: "tab-a2",
            url: "https://example.com/b",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("ignores new tabs on sessions no agent created or drove", () => {
    collectNewAgentTabsFromSessionFrame(
      agentSessionFixture({ sessionId: "session-user", agentRunId: null }),
    );
    const updated = agentSessionFixture({
      sessionId: "session-user",
      agentRunId: null,
    });
    expect(
      collectNewAgentTabsFromSessionFrame({
        ...updated,
        tabs: [
          ...updated.tabs,
          {
            tabId: "tab-u2",
            url: "https://example.com/u",
            originTier: "external",
            status: "provisioning",
            title: null,
            viewed: false,
            drivenBy: [],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("treats a session with any driven tab as agent-created", () => {
    collectNewAgentTabsFromSessionFrame(
      agentSessionFixture({ sessionId: "session-mixed", agentRunId: null }),
    );
    const updated = agentSessionFixture({
      sessionId: "session-mixed",
      agentRunId: null,
    });
    const driven = {
      ...updated,
      tabs: [
        {
          ...updated.tabs[0],
          tabId: "tab-driven",
          url: "https://example.com/driven",
          drivenBy: [
            { chatId: "chat-9", agentRunId: "agent-9", requestId: "req-9" },
          ],
        },
      ],
    };
    expect(collectNewAgentTabsFromSessionFrame(driven)).toEqual([
      { tabId: "tab-driven", url: "https://example.com/driven" },
    ]);
  });

  it("re-seeds after the session is forgotten (closed)", () => {
    collectNewAgentTabsFromSessionFrame(agentSessionFixture());
    forgetSeenAgentTabsForSession("session-a");
    expect(collectNewAgentTabsFromSessionFrame(agentSessionFixture())).toEqual(
      [],
    );
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
    resetAgentTabSurfacingForTests();
    setEpicSurfaceVisibility(EPIC, true);
  });

  afterEach(() => {
    setEpicSurfaceVisibility(EPIC, false);
  });

  it("groups a same-session electron open as a tab instead of splitting", () => {
    const sourceTile = makeBrowserSessionTileRef({
      name: "Source",
      hostId: HOST,
      sessionId: "session-shared",
      tabId: "tab-source",
    });
    seedCanvasWithTile(sourceTile);

    const placed = placeAgentElectronTile({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-shared",
      tabId: "tab-second",
      url: "https://example.com/second",
    });
    expect(placed).toBe(true);

    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    expect(collectPanes(canvas.root)).toHaveLength(1);
    expect(findPaneIdHostingSessionTile(canvas, "session-shared")).not.toBeNull();
  });

  it("splits right of the anchor pane for a brand-new session", () => {
    const sourceTile = makeBrowserTileRef({
      name: "Source browser",
      hostId: HOST,
      url: "https://app.example/source",
      viewportPreset: "responsive",
    });
    const anchorPaneId = seedCanvasWithTile(sourceTile);

    const placed = placeAgentElectronTile({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-fresh",
      tabId: "tab-fresh",
      url: "https://example.com/fresh",
    });
    expect(placed).toBe(true);

    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    const panes = collectPanes(canvas.root);
    expect(panes).toHaveLength(2);
    const hostingPaneId = findPaneIdHostingSessionTile(
      canvas,
      "session-fresh",
    );
    expect(hostingPaneId).not.toBeNull();
    expect(hostingPaneId).not.toBe(anchorPaneId);
    const activePane = panes.find((pane) => pane.id === hostingPaneId);
    expect(activePane?.id).toBe(canvas.activePaneId);
  });

  it("places a read-only session tile split beside the active pane for headless opens", () => {
    seedCanvasWithTile(
      makeBrowserTileRef({
        name: "Chat pane filler",
        hostId: HOST,
        url: "https://app.example/chat",
        viewportPreset: "responsive",
      }),
    );

    const placed = placeHeadlessAgentSessionTile({
      epicId: EPIC,
      hostId: HOST,
      sessionId: "session-headless",
      tabId: "tab-h1",
      url: "https://example.com/headless",
    });
    expect(placed).toBe(true);

    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
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

describe("surfaceAgentTabsFromSessionFrame", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
    dismissPip(EPIC);
    resetAgentTabSurfacingForTests();
    useSettingsStore.setState({ agentTabSurfacingMode: "off" });
  });

  function frameWithExtraTab(tabId: string): BrowserSessionInfo {
    const base = agentSessionFixture();
    collectNewAgentTabsFromSessionFrame(base);
    return {
      ...base,
      tabs: [
        ...base.tabs,
        {
          tabId,
          url: `https://example.com/${tabId}`,
          originTier: "external",
          status: "provisioning",
          title: null,
          viewed: false,
          drivenBy: [],
        },
      ],
    };
  }

  it("does nothing in off mode beyond bookkeeping", () => {
    surfaceAgentTabsFromSessionFrame(frameWithExtraTab("tab-x"));
    expect(getPipSnapshot(EPIC).target).toBeNull();
    expect(getPipSnapshot(EPIC).pendingTarget).toBeNull();
    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    expect(canvas === undefined || canvas.root === null).toBe(true);
    // A second identical frame reports nothing new.
    expect(collectNewAgentTabsFromSessionFrame(frameWithExtraTab("tab-x"))).toEqual(
      [],
    );
  });

  it("arms a pending agent PiP in pip mode on a visible epic", () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "pip" });
    setEpicSurfaceVisibility(EPIC, true);
    surfaceAgentTabsFromSessionFrame(frameWithExtraTab("tab-pip"));
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
    surfaceAgentTabsFromSessionFrame(frameWithExtraTab("tab-respected"));
    expect(getPipSnapshot(EPIC).pendingTarget).toMatchObject({
      sessionId: "other-session",
    });
    setEpicSurfaceVisibility(EPIC, false);
  });

  it("places a canvas tile in tile mode even for hidden epics", () => {
    useSettingsStore.setState({ agentTabSurfacingMode: "tile" });
    setEpicSurfaceVisibility(EPIC, false);
    seedCanvasWithTile(
      makeBrowserTileRef({
        name: "Anchor",
        hostId: HOST,
        url: "https://app.example",
        viewportPreset: "responsive",
      }),
    );
    surfaceAgentTabsFromSessionFrame(frameWithExtraTab("tab-tiled"));
    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected canvas");
    }
    expect(collectPanes(canvas.root)).toHaveLength(2);
    expect(isEpicSurfaceVisible(EPIC)).toBe(false);
  });
});
