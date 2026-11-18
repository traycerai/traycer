import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { preparePendingBrowserTile } from "@/lib/browser-view/tiles/pending-browser-tab";
import {
  fakePrepareOpenTab,
  independentScope,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  buildDesktopProjectionPatch,
  projectCanvasByTabIdForDesktop,
  projectTabsForDesktop,
} from "@/stores/epics/canvas/canvas-desktop-projection";
import { parseCanvasByTabId } from "@/stores/epics/canvas/migrate-canvas";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type {
  DesktopJsonValue,
  DesktopPerWindowSnapshot,
} from "@/lib/windows/types";

const TAB_ID = "view-tab-1";
const EPIC_ID = "epic-1";

function seedCanvasTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" },
    },
    openTabOrder: [TAB_ID],
  });
}

function deferredOpenTab(): {
  readonly openTab: BrowserSessionsState["openTab"];
  readonly resolve: (opened: { sessionId: string; tabId: string }) => void;
} {
  let resolve:
    | ((opened: {
        sessionId: string;
        tabId: string;
        handoffToken: null;
      }) => void)
    | null = null;
  const promise = new Promise<{
    readonly sessionId: string;
    readonly tabId: string;
    readonly handoffToken: null;
  }>((res) => {
    resolve = res;
  });
  return {
    openTab: () => promise,
    resolve: (opened) => resolve?.({ ...opened, handoffToken: null }),
  };
}

const NEVER_RESOLVES: BrowserSessionsState["openTab"] = () =>
  new Promise(() => undefined);

function sessionsValue(
  openTab: BrowserSessionsState["openTab"],
): BrowserSessionsState {
  return {
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items: [],
    viewports: {},
    setViewport: () => Promise.reject(new Error("not used")),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: () => undefined,
    openTab,
    prepareOpenTab: fakePrepareOpenTab({
      hostId: () => "host-1",
      scope: independentScope(),
      openTab,
    }),
    closeTab: () => Promise.resolve(),
    attachTab: () => Promise.reject(new Error("not used")),
    moveTab: () => Promise.reject(new Error("not used")),
  };
}

function isJsonRecord(
  value: DesktopJsonValue,
): value is { readonly [key: string]: DesktopJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The real echo desktop would send back, off the live store. */
function echoSnapshot(): DesktopPerWindowSnapshot {
  const state = useEpicCanvasStore.getState();
  const epicTabs = projectTabsForDesktop(state);
  const canvasByTabId = projectCanvasByTabIdForDesktop(state);
  if (epicTabs === undefined || canvasByTabId === undefined) {
    throw new Error("expected concrete desktop projection fields");
  }
  return {
    epicTabs,
    activeTabId: state.activeTabId,
    canvasByTabId,
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

function rawCanvasFor(snapshot: DesktopPerWindowSnapshot): {
  readonly [key: string]: DesktopJsonValue;
} {
  const raw = snapshot.canvasByTabId[TAB_ID];
  if (!isJsonRecord(raw)) {
    throw new Error("expected a serialized canvas for the tab");
  }
  return raw;
}

describe("buildDesktopProjectionPatch", () => {
  beforeEach(() => {
    seedCanvasTab();
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("retains a live pending browser tile across its own echo (raw slot null, current serialize behavior)", () => {
    const { node, request } = preparePendingBrowserTile(
      sessionsValue(NEVER_RESOLVES),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);

    const echo = echoSnapshot();
    const rawCanvas = rawCanvasFor(echo);
    const rawRoot = rawCanvas.root;
    if (!isJsonRecord(rawRoot)) {
      throw new Error("expected a serialized pane");
    }
    expect(rawRoot.tabInstanceIds).toContain(node.instanceId);
    const rawTiles = rawCanvas.tilesByInstanceId;
    expect(isJsonRecord(rawTiles) ? rawTiles[node.instanceId] : undefined).toBe(
      null,
    );

    const before = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const patch = buildDesktopProjectionPatch(
      useEpicCanvasStore.getState(),
      echo,
    );
    const patchedCanvas = patch.canvasByTabId?.[TAB_ID];

    // Same reference as `before`: the overlay makes the re-parsed canvas
    // structurally equal to the live one, so identity reuse keeps it.
    expect(patchedCanvas).toBe(before);
    const patchedTile = patchedCanvas?.tilesByInstanceId[node.instanceId];
    expect(
      patchedTile?.type === "browser-session"
        ? patchedTile.pending?.requestId
        : undefined,
    ).toBe(request.requestId);
  });

  it("control: parsing the raw echo alone (no live state) still drops the pending tile and its slot", () => {
    const { node } = preparePendingBrowserTile(
      sessionsValue(NEVER_RESOLVES),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);

    const parsed = parseCanvasByTabId(echoSnapshot().canvasByTabId);

    expect(parsed[TAB_ID]?.tilesByInstanceId[node.instanceId]).toBeUndefined();
    const parsedPane = parsed[TAB_ID]?.root;
    expect(
      parsedPane?.kind === "pane"
        ? parsedPane.tabInstanceIds.includes(node.instanceId)
        : false,
    ).toBe(false);
  });

  it("control: an explicit removal (echo's pane no longer lists the instance) still removes the tile", () => {
    const { node } = preparePendingBrowserTile(
      sessionsValue(NEVER_RESOLVES),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);

    const echo = echoSnapshot();
    const rawCanvas = rawCanvasFor(echo);
    const rawRoot = rawCanvas.root;
    if (!isJsonRecord(rawRoot)) {
      throw new Error("expected a serialized pane");
    }
    // Desktop genuinely closed the only tile in this pane.
    const closedEcho: DesktopPerWindowSnapshot = {
      ...echo,
      canvasByTabId: {
        ...echo.canvasByTabId,
        [TAB_ID]: { ...rawCanvas, root: { ...rawRoot, tabInstanceIds: [] } },
      },
    };

    const patch = buildDesktopProjectionPatch(
      useEpicCanvasStore.getState(),
      closedEcho,
    );

    expect(
      patch.canvasByTabId?.[TAB_ID]?.tilesByInstanceId[node.instanceId],
    ).toBeUndefined();
  });

  it("keeps the pending tile in its own pane through a split-pane round trip while a real edit to its resolved sibling still applies", () => {
    const { node, request } = preparePendingBrowserTile(
      sessionsValue(NEVER_RESOLVES),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);
    const pendingPaneId =
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.root?.id;
    if (pendingPaneId === undefined) throw new Error("expected a seeded pane");

    const sibling = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-sibling",
      tabId: "tab-sibling",
    });
    useEpicCanvasStore
      .getState()
      .splitPaneWithNode(TAB_ID, pendingPaneId, "right", sibling);

    const echo = echoSnapshot();
    const rawCanvas = rawCanvasFor(echo);
    const rawTiles = rawCanvas.tilesByInstanceId;
    if (!isJsonRecord(rawTiles)) throw new Error("expected serialized tiles");
    const rawSibling = rawTiles[sibling.instanceId];
    if (!isJsonRecord(rawSibling))
      throw new Error("expected serialized sibling");
    const editedEcho: DesktopPerWindowSnapshot = {
      ...echo,
      canvasByTabId: {
        ...echo.canvasByTabId,
        [TAB_ID]: {
          ...rawCanvas,
          tilesByInstanceId: {
            ...rawTiles,
            [sibling.instanceId]: { ...rawSibling, viewportPreset: "mobile" },
          },
        },
      },
    };

    const patch = buildDesktopProjectionPatch(
      useEpicCanvasStore.getState(),
      editedEcho,
    );
    const patchedCanvas = patch.canvasByTabId?.[TAB_ID];

    const patchedPending = patchedCanvas?.tilesByInstanceId[node.instanceId];
    expect(
      patchedPending?.type === "browser-session"
        ? patchedPending.pending?.requestId
        : undefined,
    ).toBe(request.requestId);
    const pendingPaneAfter =
      patchedCanvas === undefined
        ? null
        : collectPanes(patchedCanvas.root).find((pane) =>
            pane.tabInstanceIds.includes(node.instanceId),
          )?.id;
    expect(pendingPaneAfter).toBe(pendingPaneId);

    const patchedSibling = patchedCanvas?.tilesByInstanceId[sibling.instanceId];
    expect(
      patchedSibling?.type === "browser-session"
        ? patchedSibling.viewportPreset
        : undefined,
    ).toBe("mobile");
  });

  it("keeps a rebound tile when an older still-pending echo (raw slot null) arrives after the rebind", async () => {
    const deferred = deferredOpenTab();
    const { node, request } = preparePendingBrowserTile(
      sessionsValue(deferred.openTab),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);

    // The stale echo, captured while still pending (raw slot null).
    const staleEcho = echoSnapshot();

    deferred.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    await request.send();

    const patch = buildDesktopProjectionPatch(
      useEpicCanvasStore.getState(),
      staleEcho,
    );

    // `parsePersistedTiles` only overlays a null raw value when the LOCAL
    // tile is still pending - by now it is resolved, so the stale echo's
    // null must not drop or revert it.
    expect(
      patch.canvasByTabId?.[TAB_ID]?.tilesByInstanceId[node.instanceId],
    ).toMatchObject({ sessionId: "sess-1", tabId: "tab-1" });
  });
});
