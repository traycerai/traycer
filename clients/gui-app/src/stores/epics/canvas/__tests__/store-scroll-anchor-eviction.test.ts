import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import {
  useTileScrollAnchorStore,
  type TileScrollAnchor,
} from "@/stores/epics/canvas/tile-scroll-anchor-store";
import {
  evictChatTabState,
  hasSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import {
  evictActivityGroupOpenStores,
  getOrCreateActivityGroupOpenStore,
} from "@/stores/chats/activity-group-open-store-core";
import {
  evictA2AOpenStores,
  getOrCreateA2AOpenStore,
} from "@/stores/chats/a2a-open-store-context";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { useTileFindStore } from "@/stores/tile-find";
import type { TileFindCapability, TileFindUiState } from "@/stores/tile-find";
import { SPEC_A } from "./canvas-test-fixtures";

const EMPTY_TILE_FIND_CAPABILITIES: ReadonlySet<TileFindCapability> = new Set();

const SEEDED_TILE_FIND_UI: TileFindUiState = {
  isOpen: true,
  query: "needle",
  matchCase: false,
  replaceText: "",
  replaceExpanded: false,
  currentRequestId: 1,
  focusRequestNonce: 0,
  lastSnapshot: {
    requestId: 1,
    status: "ready",
    capabilities: EMPTY_TILE_FIND_CAPABILITIES,
    query: "needle",
    matchCase: false,
    replaceText: "",
    current: 1,
    total: 1,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: null,
    exactHighlight: "none",
  },
};

const ANCHOR: TileScrollAnchor = {
  kind: "native",
  scrollTop: 240,
  scrollLeft: 0,
  scrollHeight: 1200,
  scrollWidth: 600,
};

function seedTicket5PerTabState(instanceId: string): void {
  saveChatTabState({
    key: instanceId,
    mode: "free-scrolling",
    anchorMessageId: "msg-seed",
    offset: 24,
  });
  getOrCreateActivityGroupOpenStore(instanceId)
    .getState()
    .setOpen("activity-g1", true);
  getOrCreateA2AOpenStore(instanceId).getState().setSentOpen("a2a-sent", true);
  useToolOpenStore.getState().setOpen(instanceId, "tool-1", true);
  useSubagentOpenStore.getState().setOpen(instanceId, "sub-1", true);
  // F4: models a chat tile whose find bar was open when it switched away
  // (unregistered while live, so scheduleUiReclaim left this `ui` entry in
  // place) - the sweep below is the ONLY thing that can ever reclaim it now.
  useTileFindStore.setState((state) => ({
    uiByTileInstanceId: {
      ...state.uiByTileInstanceId,
      [instanceId]: SEEDED_TILE_FIND_UI,
    },
  }));
}

function expectTicket5PerTabStatePresent(instanceId: string): void {
  expect(hasSavedChatTabState(instanceId)).toBe(true);
  expect(restoreChatTabState(instanceId, []).mode).toBe("free-scrolling");
  expect(
    getOrCreateActivityGroupOpenStore(instanceId)
      .getState()
      .openIds.has("activity-g1"),
  ).toBe(true);
  expect(
    getOrCreateA2AOpenStore(instanceId).getState().sentOpenIds.has("a2a-sent"),
  ).toBe(true);
  expect(
    useToolOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(instanceId, "tool-1")),
  ).toBe(true);
  expect(
    useSubagentOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(instanceId, "sub-1")),
  ).toBe(true);
  expect(useTileFindStore.getState().uiByTileInstanceId[instanceId]).toEqual(
    SEEDED_TILE_FIND_UI,
  );
}

function expectTicket5PerTabStateEvicted(instanceId: string): void {
  expect(hasSavedChatTabState(instanceId)).toBe(false);
  // Registry eviction drops the prior store; a new getOrCreate is empty.
  expect(
    getOrCreateActivityGroupOpenStore(instanceId)
      .getState()
      .openIds.has("activity-g1"),
  ).toBe(false);
  expect(
    getOrCreateA2AOpenStore(instanceId).getState().sentOpenIds.has("a2a-sent"),
  ).toBe(false);
  expect(
    useToolOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(instanceId, "tool-1")),
  ).toBe(false);
  expect(
    useSubagentOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(instanceId, "sub-1")),
  ).toBe(false);
  expect(
    useTileFindStore.getState().uiByTileInstanceId[instanceId],
  ).toBeUndefined();
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTileScrollAnchorStore.setState({ anchors: {} });
  useToolOpenStore.setState({ openIds: new Set() });
  useSubagentOpenStore.setState({ openIds: new Set() });
  evictChatTabState([SPEC_A.instanceId]);
  evictActivityGroupOpenStores([SPEC_A.instanceId]);
  evictA2AOpenStores([SPEC_A.instanceId]);
  useTileFindStore.getState().resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  useToolOpenStore.setState({ openIds: new Set() });
  useSubagentOpenStore.setState({ openIds: new Set() });
  evictChatTabState([SPEC_A.instanceId]);
  evictActivityGroupOpenStores([SPEC_A.instanceId]);
  evictA2AOpenStores([SPEC_A.instanceId]);
  useTileFindStore.getState().resetForTests();
});

describe("canvas store scroll-anchor sweep", () => {
  it("evicts a tile's anchor when its canvas is permanently removed", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-evict", "Evict Me");
    store.openTileInTab(tabId, SPEC_A);
    useTileScrollAnchorStore.getState().setAnchor(SPEC_A.instanceId, ANCHOR);

    useEpicCanvasStore.getState().closeTabsForEpics(["epic-evict"]);

    expect(
      useTileScrollAnchorStore.getState().getAnchor(SPEC_A.instanceId),
    ).toBeUndefined();
  });

  it("preserves the anchor across a hide-for-reopen close (tile stays live)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-hide", "Hide Me");
    store.openTileInTab(tabId, SPEC_A);
    useTileScrollAnchorStore.getState().setAnchor(SPEC_A.instanceId, ANCHOR);

    // closeTab hides the tab but keeps its canvas (and tiles) for reopen, so the
    // instanceId never leaves the live set and the sweep must NOT clear it.
    store.closeTab(tabId);

    expect(
      useTileScrollAnchorStore.getState().getAnchor(SPEC_A.instanceId),
    ).toEqual(ANCHOR);
  });
});

describe("canvas store ticket-5 per-tab persistence sweep", () => {
  it("evicts chat-tab-state, activity-group/A2A registries, tool/subagent scopes, and tile-find ui on permanent close", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-t5-evict", "Evict Ticket5");
    store.openTileInTab(tabId, SPEC_A);
    seedTicket5PerTabState(SPEC_A.instanceId);
    expectTicket5PerTabStatePresent(SPEC_A.instanceId);

    useEpicCanvasStore.getState().closeTabsForEpics(["epic-t5-evict"]);

    expectTicket5PerTabStateEvicted(SPEC_A.instanceId);
  });

  it("preserves chat-tab-state, activity-group/A2A registries, tool/subagent scopes, and tile-find ui across hide-for-reopen", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-t5-hide", "Hide Ticket5");
    store.openTileInTab(tabId, SPEC_A);
    seedTicket5PerTabState(SPEC_A.instanceId);

    // closeTab keeps the canvas/tiles live for reopen - same as anchors.
    store.closeTab(tabId);

    expectTicket5PerTabStatePresent(SPEC_A.instanceId);
  });
});
