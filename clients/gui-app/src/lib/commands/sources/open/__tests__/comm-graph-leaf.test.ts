import { beforeEach, describe, expect, it } from "vitest";
import { commGraphOpenerItem } from "@/lib/commands/sources/open/comm-graph-leaf";
import { commGraphTileId } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { epicCanvasKey } from "@/lib/persist";
import type { CommandContext } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { SPEC_A } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";

const EPIC_ID = "epic-comm-graph-leaf";

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

function ctx(tabId: string, groupId: string): CommandContext {
  return {
    pathname: "/",
    router: noopRouter(),
    activeTabId: tabId,
    activeEpicId: EPIC_ID,
    focusedComposerKind: null,
    targetGroupId: groupId,
  };
}

/** Invoke the leaf exactly as the opener shell does. */
function invokeCommGraphOpener(context: CommandContext): void {
  void commGraphOpenerItem(context).run(context);
}

/** Every open tab whose content id is the epic's comm graph. */
function commGraphTabInstanceIds(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root)
    .flatMap((pane) => pane.tabInstanceIds)
    .filter(
      (instanceId) =>
        canvas.tilesByInstanceId[instanceId]?.id === commGraphTileId(EPIC_ID),
    );
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("commGraphOpenerItem", () => {
  it("opens ONE graph however many times it is invoked", () => {
    // The graph's content id is derived from the epic, so a second
    // non-deduped instance would share it - and therefore share the persisted
    // viewport, making a pan of one tab move the other.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(tabId, SPEC_A);
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) throw new Error("no pane");

    invokeCommGraphOpener(ctx(tabId, paneId));
    expect(commGraphTabInstanceIds(tabId)).toHaveLength(1);
    const first = commGraphTabInstanceIds(tabId)[0];

    invokeCommGraphOpener(ctx(tabId, paneId));

    const after = commGraphTabInstanceIds(tabId);
    expect(after).toHaveLength(1);
    // Focused in place, not replaced: the same tab instance survives, so its
    // viewport and mounted subscriptions are untouched.
    expect(after[0]).toBe(first);
  });

  it("focuses the existing graph even when it lives in another pane", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(tabId, SPEC_A);
    const firstPaneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (firstPaneId === undefined || firstPaneId === null) {
      throw new Error("no pane");
    }
    invokeCommGraphOpener(ctx(tabId, firstPaneId));
    const otherPaneId = store.splitPaneEmptyRightInTab(tabId, firstPaneId);
    if (otherPaneId === null) throw new Error("no second pane");

    invokeCommGraphOpener(ctx(tabId, otherPaneId));

    expect(commGraphTabInstanceIds(tabId)).toHaveLength(1);
    // Focused, not merely deduped: the graph's OWN pane becomes the active
    // pane and the graph instance is that pane's active tab - a regression
    // that leaves focus in the empty second pane must fail here.
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.activePaneId).toBe(firstPaneId);
    const graphInstanceId = commGraphTabInstanceIds(tabId)[0];
    const owningPane = collectPanes(canvas?.root ?? null).find((pane) =>
      pane.tabInstanceIds.includes(graphInstanceId),
    );
    expect(owningPane?.id).toBe(firstPaneId);
    expect(owningPane?.activeTabId).toBe(graphInstanceId);
  });

  it("does nothing without an epic to scope the graph to", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(tabId, SPEC_A);
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) throw new Error("no pane");

    invokeCommGraphOpener({
      ...ctx(tabId, paneId),
      activeEpicId: null,
    });

    expect(commGraphTabInstanceIds(tabId)).toHaveLength(0);
  });
});
