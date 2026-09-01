import { beforeEach, describe, expect, it } from "vitest";
import { deletedArtifactsOpenerItem } from "@/lib/commands/sources/open/deleted-artifacts-leaf";
import { deletedArtifactsTileId } from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { epicCanvasKey } from "@/lib/persist";
import type { CommandContext } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { SPEC_A } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";

const EPIC_ID = "epic-deleted-artifacts-leaf";
const HOST_ID = "host-deleted-artifacts-leaf";

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

function deletedArtifactTabInstanceIds(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root)
    .flatMap((pane) => pane.tabInstanceIds)
    .filter(
      (instanceId) =>
        canvas.tilesByInstanceId[instanceId]?.id ===
        deletedArtifactsTileId(EPIC_ID, HOST_ID),
    );
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("deletedArtifactsOpenerItem", () => {
  it("opens one host-bound recovery tile and focuses it when reopened", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(tabId, SPEC_A);
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) throw new Error("no pane");
    const item = deletedArtifactsOpenerItem(ctx(tabId, paneId), HOST_ID);

    expect(item.keywords).toContain("trash");
    expect(item.keywords).toContain("restore");
    void item.run(ctx(tabId, paneId));
    const first = deletedArtifactTabInstanceIds(tabId);
    expect(first).toHaveLength(1);

    void item.run(ctx(tabId, paneId));

    expect(deletedArtifactTabInstanceIds(tabId)).toEqual(first);
  });

  it("does nothing without an epic to scope recovery to", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(tabId, SPEC_A);
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
    if (paneId === undefined || paneId === null) throw new Error("no pane");

    void deletedArtifactsOpenerItem(
      { ...ctx(tabId, paneId), activeEpicId: null },
      HOST_ID,
    ).run(ctx(tabId, paneId));

    expect(deletedArtifactTabInstanceIds(tabId)).toHaveLength(0);
  });
});
