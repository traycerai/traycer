import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  resetTabsStoreForTest,
  seedActiveEpicTabInTabsStore,
} from "@/stores/tabs/test-support/tabs-store-fixtures";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

const closeLayoutEditorForCloseTabChordMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/layout/editor-session", () => ({
  closeLayoutEditorForCloseTabChord: closeLayoutEditorForCloseTabChordMock,
}));

const CHAT_A: EpicNodeRef = {
  id: "chat-a",
  instanceId: "inst-a",
  type: "chat",
  name: "Chat A",
  hostId: "host-A",
};

const SEED_EPIC_ID = "epic-close-tab-chord";

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

/** Mirrors `dispatch-focus-editor.test.ts`'s fixture: one tab, one tile. */
function seedActiveGroupTab(): string {
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab(SEED_EPIC_ID, "Epic");
  store.openTileInTab(tabId, CHAT_A);
  seedActiveEpicTabInTabsStore(tabId);
  return tabId;
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  resetTabsStoreForTest();
  closeLayoutEditorForCloseTabChordMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * Cmd+W while a layout editor session is open is Done, whatever tab has
 * focus (item 3, `editor-session.ts`'s `closeLayoutEditorForCloseTabChord`).
 * The door itself is that function's own suite; what this one asks is that
 * `dispatchAction` asks it FIRST, for both close ids, and never falls
 * through to the ordinary tab/epic close handler while it answers `true`.
 */
describe("dispatchAction defers tab.close/epic.close to the layout editor's close chord", () => {
  it("runs the ordinary epic.close handler when no session is open", () => {
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(false);
    const tabId = seedActiveGroupTab();
    const closeTabSpy = vi.spyOn(useEpicCanvasStore.getState(), "closeTab");

    const result = dispatchAction("epic.close", routerForTab(tabId));

    expect(closeLayoutEditorForCloseTabChordMock).toHaveBeenCalledOnce();
    expect(result).toBe(true);
    expect(closeTabSpy).toHaveBeenCalledWith(tabId);
  });

  it("intercepts epic.close as Done while a session is open, leaving the epic tab untouched", () => {
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(true);
    const tabId = seedActiveGroupTab();
    const closeTabSpy = vi.spyOn(useEpicCanvasStore.getState(), "closeTab");

    const result = dispatchAction("epic.close", routerForTab(tabId));

    expect(result).toBe(true);
    expect(closeTabSpy).not.toHaveBeenCalled();
    expect(useEpicCanvasStore.getState().tabsById[tabId]).not.toBeUndefined();
  });

  it("runs the ordinary tab.close handler when no session is open", () => {
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(false);
    const tabId = seedActiveGroupTab();
    const prepareSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "prepareCloseCanvasTabFocusTarget",
    );

    const result = dispatchAction("tab.close", routerForTab(tabId));

    expect(closeLayoutEditorForCloseTabChordMock).toHaveBeenCalledOnce();
    expect(result).toBe(true);
    expect(prepareSpy).toHaveBeenCalled();
  });

  it("intercepts tab.close as Done while a session is open, leaving the tile untouched", () => {
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(true);
    const tabId = seedActiveGroupTab();
    const prepareSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "prepareCloseCanvasTabFocusTarget",
    );

    const result = dispatchAction("tab.close", routerForTab(tabId));

    expect(result).toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    expect(canvas?.activePaneId).not.toBeNull();
  });

  it("leaves every other action alone, asking the chord nothing", () => {
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(true);
    const tabId = seedActiveGroupTab();

    dispatchAction("tab.new", routerForTab(tabId));

    expect(closeLayoutEditorForCloseTabChordMock).not.toHaveBeenCalled();
  });
});
