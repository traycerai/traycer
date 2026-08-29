import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBrowserAddressInput,
  openBrowserSessionTileFromPage,
  routeBrowserLink,
  type BrowserLinkSource,
} from "@/lib/browser-view/link-routing/browser-link-routing-core";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isBrowserSessionTileRef,
  type BrowserSessionTileRef,
  type EpicCanvasState,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";

const VIEW_TAB_ID = "view-tab-routing";
const HOST_ID = "host-routing";
const SOURCE_TILE: EpicCanvasTileRef = {
  id: "ticket-routing",
  instanceId: "ticket-routing-instance",
  type: "ticket",
  name: "Ticket",
  hostId: HOST_ID,
};

function resetStores(): void {
  useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
  useSettingsStore.setState({
    browserLinkDefaultMode: "in-app",
    terminalBrowserLinkOpenMode: "in-app",
    markdownBrowserLinkOpenMode: "in-app",
    browserDevOrigins: [],
  });
}

function mockRunnerHost() {
  return { openExternalLink: vi.fn(() => Promise.resolve()) };
}

function seedCanvas(node: EpicCanvasTileRef): BrowserLinkSource {
  const canvas = createSingleTileCanvas(node);
  const pane = singlePane(canvas);
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: "epic-routing",
        name: "Routing",
      },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
  return { viewTabId: VIEW_TAB_ID, paneId: pane.id, hostId: node.hostId };
}

function singlePane(canvas: EpicCanvasState) {
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected a pane");
  return pane;
}

function browserSessionTiles(): ReadonlyArray<BrowserSessionTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (canvas === undefined) return [];
  return Object.values(canvas.tilesByInstanceId).filter(
    (tile): tile is BrowserSessionTileRef =>
      tile !== undefined && isBrowserSessionTileRef(tile),
  );
}

describe("browser link routing", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("delegates enabled in-app links to the host-backed opener", () => {
    const source = seedCanvas(SOURCE_TILE);
    const runnerHost = mockRunnerHost();
    const openInApp = vi.fn(() => true);

    const result = routeBrowserLink({
      runnerHost,
      source,
      kind: "markdown",
      url: "https://example.test/docs",
      event: null,
      openInApp,
    });

    expect(result).toBe("in-app");
    expect(openInApp).toHaveBeenCalledWith(source, "https://example.test/docs");
    expect(runnerHost.openExternalLink).not.toHaveBeenCalled();
  });

  it("falls back externally when host-backed opening is unavailable", () => {
    const runnerHost = mockRunnerHost();

    const result = routeBrowserLink({
      runnerHost,
      source: seedCanvas(SOURCE_TILE),
      kind: "markdown",
      url: "https://example.test/docs",
      event: null,
      openInApp: () => false,
    });

    expect(result).toBe("external");
    expect(runnerHost.openExternalLink).toHaveBeenCalledWith(
      "https://example.test/docs",
    );
  });

  it("honors per-kind settings and the alt-click override", () => {
    const source = seedCanvas(SOURCE_TILE);
    const runnerHost = mockRunnerHost();
    const openInApp = vi.fn(() => true);
    useSettingsStore.setState({
      browserLinkDefaultMode: "per-kind",
      terminalBrowserLinkOpenMode: "in-app",
      markdownBrowserLinkOpenMode: "external",
    });

    expect(
      routeBrowserLink({
        runnerHost,
        source,
        kind: "markdown",
        url: "https://example.test/markdown",
        event: null,
        openInApp,
      }),
    ).toBe("external");
    expect(
      routeBrowserLink({
        runnerHost,
        source,
        kind: "markdown",
        url: "https://example.test/markdown-alt",
        event: { altKey: true },
        openInApp,
      }),
    ).toBe("in-app");
    expect(
      routeBrowserLink({
        runnerHost,
        source,
        kind: "terminal",
        url: "https://example.test/terminal-alt",
        event: { altKey: true },
        openInApp,
      }),
    ).toBe("external");

    expect(openInApp).toHaveBeenCalledOnce();
    expect(openInApp).toHaveBeenCalledWith(
      source,
      "https://example.test/markdown-alt",
    );
  });

  it("records terminal dev-server origins from URL output only", () => {
    const source = seedCanvas(SOURCE_TILE);
    const runnerHost = mockRunnerHost();

    for (const [kind, url] of [
      ["terminal", "http://localhost:5173/ready"],
      ["terminal", "http://localhost:5173/again"],
      ["markdown", "http://localhost:5174/docs"],
    ] as const) {
      routeBrowserLink({
        runnerHost,
        source,
        kind,
        url,
        event: null,
        openInApp: () => true,
      });
    }

    expect(useSettingsStore.getState().browserDevOrigins).toEqual([
      "http://localhost:5173",
    ]);
  });

  it("places a host-created popup as a browser-session pointer", () => {
    const source = seedCanvas(SOURCE_TILE);

    const opened = openBrowserSessionTileFromPage({
      ...source,
      sessionId: "session-popup",
      tabId: "tab-popup",
      url: "https://popup.example/oauth",
    });

    expect(opened).toBe(true);
    expect(browserSessionTiles()).toMatchObject([
      {
        type: "browser-session",
        hostId: HOST_ID,
        sessionId: "session-popup",
        tabId: "tab-popup",
        viewportPreset: "responsive",
      },
    ]);
  });
});

describe("browser address helpers", () => {
  it("normalizes address bar input conservatively", () => {
    expect(normalizeBrowserAddressInput("example.test/docs")).toBe(
      "https://example.test/docs",
    );
    expect(normalizeBrowserAddressInput("localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(normalizeBrowserAddressInput("about:blank")).toBe("about:blank");
    expect(normalizeBrowserAddressInput("   ")).toBe("about:blank");
  });
});
