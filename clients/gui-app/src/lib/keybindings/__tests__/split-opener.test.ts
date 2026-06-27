import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

const SPEC_A: EpicNodeRef = {
  id: "art-a",
  instanceId: "inst-a",
  type: "spec",
  name: "Spec A",
  hostId: "host-A",
};
const SPEC_B: EpicNodeRef = {
  id: "art-b",
  instanceId: "inst-b",
  type: "spec",
  name: "Spec B",
  hostId: "host-A",
};

const SEED_EPIC_ID = "epic-split";

// The keybinding dispatch resolves the active epic tab from the route
// (`/epics/<epicId>/<tabId>`), so the test router must point at the seeded tab.
function routerForTab(tabId: string): KeybindingRouter {
  return {
    getPathname: () => `/epics/${SEED_EPIC_ID}/${tabId}`,
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

function seedActiveGroupTab(): string {
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab(SEED_EPIC_ID, "Epic");
  store.openTileInTab(tabId, SPEC_A);
  return tabId;
}

function activeGroupId(tabId: string): string {
  const groupId =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null;
  if (groupId === null) throw new Error("expected an active group");
  return groupId;
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
});

afterEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

// Splits create an empty pane that self-renders the inline opener
// (PaneOpener); they must NOT pop the modal ⌘K palette.
describe("split creates an empty pane (inline opener)", () => {
  it("binds mod+d to split right and mod+shift+d to split down by default", () => {
    const bindings = getDefaultBindings();
    expect(bindings["group.split.horizontal"]).toBe("mod+d");
    expect(bindings["group.split.vertical"]).toBe("mod+shift+d");
  });

  for (const action of [
    "group.split.horizontal",
    "group.split.vertical",
    "group.split-right",
  ] as const) {
    it(`${action} creates a new empty group without opening the modal palette`, () => {
      const tabId = seedActiveGroupTab();
      dispatchAction(action, routerForTab(tabId));

      const newGroupId = activeGroupId(tabId);
      const root = useEpicCanvasStore.getState().canvasByTabId[tabId]?.root;
      const group = findPaneById(root ?? null, newGroupId);
      expect(group?.tabInstanceIds).toHaveLength(0);
      // The modal command palette stays closed - the pane renders the opener.
      expect(useCommandPaletteStore.getState().open).toBe(false);
    });
  }

  it("group.split.horizontal creates a right split", () => {
    const tabId = seedActiveGroupTab();
    dispatchAction("group.split.horizontal", routerForTab(tabId));

    const root = useEpicCanvasStore.getState().canvasByTabId[tabId]?.root;
    expect(root?.kind).toBe("group");
    if (root?.kind !== "group") return;
    expect(root.direction).toBe("horizontal");
  });

  it("group.split.vertical creates a down split", () => {
    const tabId = seedActiveGroupTab();
    dispatchAction("group.split.vertical", routerForTab(tabId));

    const root = useEpicCanvasStore.getState().canvasByTabId[tabId]?.root;
    expect(root?.kind).toBe("group");
    if (root?.kind !== "group") return;
    expect(root.direction).toBe("vertical");
  });

  it("drag-drop into the new empty pane still works", () => {
    const tabId = seedActiveGroupTab();
    dispatchAction("group.split-right", routerForTab(tabId));
    const newGroupId = activeGroupId(tabId);

    useEpicCanvasStore
      .getState()
      .insertNodeOnTabStrip(tabId, newGroupId, 0, SPEC_B);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const group = findPaneById(canvas?.root ?? null, newGroupId);
    if (group === null || canvas === undefined) {
      throw new Error("expected a resolvable pane");
    }
    expect(paneTabRefs(canvas, group).map((tab) => tab.id)).toEqual([
      SPEC_B.id,
    ]);
  });

  it("tab.close closes the active empty split pane", () => {
    const tabId = seedActiveGroupTab();
    const originalGroupId = activeGroupId(tabId);
    dispatchAction("group.split-right", routerForTab(tabId));
    const emptyGroupId = activeGroupId(tabId);

    expect(dispatchAction("tab.close", routerForTab(tabId))).toBe(true);

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const panes = collectPanes(canvas?.root ?? null);
    expect(panes.map((pane) => pane.id)).toEqual([originalGroupId]);
    expect(panes.some((pane) => pane.id === emptyGroupId)).toBe(false);
    expect(canvas?.activePaneId).toBe(originalGroupId);
  });
});
