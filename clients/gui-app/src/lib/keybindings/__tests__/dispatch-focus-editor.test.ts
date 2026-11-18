import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";

const CHAT_A: EpicNodeRef = {
  id: "chat-a",
  instanceId: "inst-a",
  type: "chat",
  name: "Chat A",
  hostId: "host-A",
};

const SEED_EPIC_ID = "epic-focus-editor";

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

function seedActiveGroupTab(): {
  readonly tabId: string;
  readonly groupId: string;
  readonly instanceId: string;
} {
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab(SEED_EPIC_ID, "Epic");
  store.openTileInTab(tabId, CHAT_A);
  seedActiveEpicTabInTabsStore(tabId);
  const groupId =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null;
  if (groupId === null) throw new Error("expected an active group");
  return { tabId, groupId, instanceId: CHAT_A.instanceId };
}

/** Mirrors `TabGroupView`'s own tab-body wrapper markup - see `tab-group-view.tsx`. */
function buildSelectedTabWrapper(
  groupId: string,
  instanceId: string,
): HTMLElement {
  const group = document.createElement("div");
  group.setAttribute("data-group-id", groupId);
  const selectedTab = document.createElement("div");
  selectedTab.setAttribute("data-tab-instance-id", instanceId);
  selectedTab.setAttribute("data-selected", "true");
  group.appendChild(selectedTab);
  document.body.appendChild(group);
  return selectedTab;
}

function appendComposerEditor(parent: HTMLElement): HTMLElement {
  const composer = document.createElement("div");
  composer.setAttribute("data-chat-composer", "");
  const editor = document.createElement("div");
  editor.setAttribute("data-composer-editor", "");
  editor.setAttribute("tabindex", "-1");
  composer.appendChild(editor);
  parent.appendChild(composer);
  return editor;
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  resetTabsStoreForTest();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("dispatchAction group.focus-editor (ticket 21 slice 4 hosted fallback)", () => {
  it("focuses the physical composer when the tile is inline", () => {
    const { tabId, groupId, instanceId } = seedActiveGroupTab();
    const selectedTab = buildSelectedTabWrapper(groupId, instanceId);
    const editor = appendComposerEditor(selectedTab);

    const result = dispatchAction("group.focus-editor", routerForTab(tabId));
    expect(result).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it("falls back to the hosted record's composer when the selected tab only holds a geometry anchor", () => {
    const { tabId, groupId, instanceId } = seedActiveGroupTab();
    // Empty - models `TileSurfaceSlot`'s geometry anchor with no real body.
    buildSelectedTabWrapper(groupId, instanceId);

    const hostedRecord = document.createElement("div");
    hostedRecord.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, instanceId);
    hostedRecord.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, groupId);
    document.body.appendChild(hostedRecord);
    const editor = appendComposerEditor(hostedRecord);

    const result = dispatchAction("group.focus-editor", routerForTab(tabId));
    expect(result).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it("does not reach for a hosted record belonging to a different instance", () => {
    const { tabId, groupId, instanceId } = seedActiveGroupTab();
    buildSelectedTabWrapper(groupId, instanceId);

    const unrelatedHostedRecord = document.createElement("div");
    unrelatedHostedRecord.setAttribute(
      HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
      "some-other-instance",
    );
    unrelatedHostedRecord.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, groupId);
    document.body.appendChild(unrelatedHostedRecord);
    appendComposerEditor(unrelatedHostedRecord);

    const before = document.activeElement;
    dispatchAction("group.focus-editor", routerForTab(tabId));
    expect(document.activeElement).toBe(before);
  });
});
