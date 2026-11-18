import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { preparePendingBrowserTile } from "@/lib/browser-view/tiles/pending-browser-tab";
import {
  fakePrepareOpenTab,
  independentScope,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";

const TAB_A = "view-tab-1";
const TAB_B = "view-tab-2";

function seedCanvasTabs(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_A]: { tabId: TAB_A, epicId: "epic-1", name: "Epic 1" },
      [TAB_B]: { tabId: TAB_B, epicId: "epic-2", name: "Epic 2" },
    },
    openTabOrder: [TAB_A, TAB_B],
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

/** Find the live tile carrying this pending request in `tabId`'s canvas, by
 * requestId rather than whatever instance id it was minted under. */
function findByRequestId(tabId: string, requestId: string) {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  for (const pane of collectPanes(canvas.root)) {
    for (const instanceId of pane.tabInstanceIds) {
      const ref = canvas.tilesByInstanceId[instanceId];
      if (
        ref?.type === "browser-session" &&
        ref.pending?.requestId === requestId
      ) {
        return { instanceId, paneId: pane.id, ref };
      }
    }
  }
  return null;
}

function findByInstanceId(tabId: string, instanceId: string) {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  for (const pane of collectPanes(canvas.root)) {
    if (!pane.tabInstanceIds.includes(instanceId)) continue;
    const ref = canvas.tilesByInstanceId[instanceId];
    if (ref === undefined) continue;
    return { paneId: pane.id, ref };
  }
  return null;
}

describe("preparePendingBrowserTile", () => {
  beforeEach(() => {
    seedCanvasTabs();
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("can structuredClone the canvas state it was opened into", () => {
    const deferred = deferredOpenTab();
    const { node } = preparePendingBrowserTile(
      sessionsValue(deferred.openTab),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_A, node);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_A];
    expect(() => structuredClone(canvas)).not.toThrow();
  });

  it("survives a populated-pane open and rebinds in place, same instance and pane", async () => {
    const existing = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-existing",
      tabId: "tab-existing",
    });
    useEpicCanvasStore.getState().openTileInTab(TAB_A, existing);
    const paneId = useEpicCanvasStore.getState().canvasByTabId[TAB_A]?.root?.id;
    if (paneId === undefined) throw new Error("expected a seeded pane");

    const deferred = deferredOpenTab();
    const { node, request, observe } = preparePendingBrowserTile(
      sessionsValue(deferred.openTab),
      "about:blank",
    );
    // `openTileInPane` mints a fresh instance id for a populated pane.
    useEpicCanvasStore
      .getState()
      .openTileInPane(TAB_A, paneId, node, { mode: "permanent", index: null });

    const landed = findByRequestId(TAB_A, request.requestId);
    expect(landed).not.toBeNull();
    expect(landed?.instanceId).not.toBe(node.instanceId);

    observe();
    expect(findByRequestId(TAB_A, request.requestId)).not.toBeNull();

    deferred.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    await request.send();

    const rebound = findByInstanceId(TAB_A, landed?.instanceId ?? "");
    expect(rebound?.paneId).toBe(landed?.paneId);
    expect(rebound?.ref).toMatchObject({ sessionId: "sess-1", tabId: "tab-1" });
  });

  it("survives an unrelated update on a second mounted surface, hiding its own tab, and rebinds to the same instance afterward", async () => {
    const deferred = deferredOpenTab();
    const { node, request, observe } = preparePendingBrowserTile(
      sessionsValue(deferred.openTab),
      "about:blank",
    );
    useEpicCanvasStore.getState().openTileInTab(TAB_A, node);
    observe();

    // A second epic surface mounted alongside it.
    useEpicCanvasStore.getState().openTileInTab(
      TAB_B,
      makeBrowserSessionTileRef({
        hostId: "host-1",
        sessionId: "sess-b",
        tabId: "tab-b",
      }),
    );
    expect(findByRequestId(TAB_A, request.requestId)).not.toBeNull();

    // TAB_A closes but is preserved (dropped from `openTabOrder`, canvas
    // entry kept) before the host answers.
    useEpicCanvasStore.setState({ openTabOrder: [TAB_B] });
    expect(findByRequestId(TAB_A, request.requestId)).not.toBeNull();

    deferred.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    await request.send();

    const rebound = findByInstanceId(TAB_A, node.instanceId);
    expect(rebound?.ref).toMatchObject({ sessionId: "sess-1", tabId: "tab-1" });
  });

  it("observe() reports failed placement and dismisses; send() afterward dispatches nothing and resolves null", async () => {
    const deferred = deferredOpenTab();
    const openTab = vi.fn(deferred.openTab);
    const { request, observe } = preparePendingBrowserTile(
      sessionsValue(openTab),
      "about:blank",
    );
    // Never placed into the canvas - the tile the request is bound to does
    // not exist, exactly what a failed placement looks like to `observe()`.

    expect(observe()).toBe(false);

    const opened = await request.send();
    expect(opened).toBeNull();
    expect(openTab).not.toHaveBeenCalled();
  });
});
