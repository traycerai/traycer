import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import {
  isBlankTileRef,
  type EpicCanvasTileRef,
  type EpicNodeRef,
} from "@/stores/epics/canvas/types";

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

const SEED_EPIC_ID = "epic-blank";

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

function activeGroup(tabId: string): {
  readonly id: string;
  readonly activeTabId: string | null;
  readonly tabs: ReadonlyArray<EpicCanvasTileRef>;
} {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error("expected a canvas");
  const paneId = canvas.activePaneId;
  if (paneId === null) throw new Error("expected an active pane");
  const pane = findPaneById(canvas.root, paneId);
  if (pane === null) throw new Error("expected a resolvable pane");
  return {
    id: pane.id,
    activeTabId: pane.activeTabId,
    tabs: paneTabRefs(canvas, pane),
  };
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

describe("tab.new default chord (mod+t) and epic.new (mod+n)", () => {
  it("binds tab.new to mod+t and epic.new to mod+n by default", () => {
    const bindings = getDefaultBindings();
    expect(bindings["tab.new"]).toBe("mod+t");
    expect(bindings["epic.new"]).toBe("mod+n");
    expect(ACTION_META["tab.new"].category).toBe("tabs");
  });
});

describe("tab.new dispatch (blank tab in active group)", () => {
  it("adds and focuses a blank 'New tab' in the active group", () => {
    const tabId = seedActiveGroupTab();
    dispatchAction("tab.new", routerForTab(tabId));

    const group = activeGroup(tabId);
    expect(group.tabs).toHaveLength(2);
    const blank = group.tabs[1];
    expect(isBlankTileRef(blank)).toBe(true);
    expect(group.activeTabId).toBe(blank.instanceId);
    // The blank body is the inline opener - the modal palette stays closed.
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("focuses the existing blank on repeated dispatch (no stacking)", () => {
    const tabId = seedActiveGroupTab();
    dispatchAction("tab.new", routerForTab(tabId));
    const firstBlankId = activeGroup(tabId).activeTabId;

    dispatchAction("tab.new", routerForTab(tabId));
    const group = activeGroup(tabId);
    expect(group.tabs).toHaveLength(2);
    expect(group.activeTabId).toBe(firstBlankId);
  });

  it("replaces the blank in place when content is then opened into it", () => {
    const tabId = seedActiveGroupTab();
    dispatchAction("tab.new", routerForTab(tabId));
    const blankGroupId = activeGroup(tabId).id;

    // Picking content while the blank is active replaces it (browser new-tab).
    useEpicCanvasStore.getState().openTileInPane(tabId, blankGroupId, SPEC_B);

    const group = activeGroup(tabId);
    expect(group.tabs.map((t) => t.id)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(group.tabs.some(isBlankTileRef)).toBe(false);
  });
});
