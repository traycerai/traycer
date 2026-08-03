import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicCanvasKey } from "@/lib/persist";
import {
  useTileScrollAnchorStore,
  type TileScrollAnchor,
} from "@/stores/epics/canvas/tile-scroll-anchor-store";
import {
  evictChatTabState,
  evictChatTabStateForEpic,
  peekSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import {
  evictActivityGroupOpenStores,
  evictActivityGroupOpenStoresForEpic,
  getOrCreateActivityGroupOpenStore,
} from "@/stores/chats/activity-group-open-store-core";
import {
  evictA2AOpenStores,
  evictA2AOpenStoresForEpic,
  getOrCreateA2AOpenStore,
} from "@/stores/chats/a2a-open-store-context";
import {
  evictToolOpenStoresForEpic,
  toolOpenInitializedScopes,
  useToolOpenStore,
} from "@/stores/chats/tool-open-store";
import {
  evictSubagentOpenStoresForEpic,
  subagentOpenInitializedScopes,
  useSubagentOpenStore,
} from "@/stores/chats/subagent-open-store";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { useTileFindStore } from "@/stores/tile-find";
import type { TileFindCapability, TileFindUiState } from "@/stores/tile-find";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import {
  pendingHydrationRestore,
  rememberPendingHydrationRestore,
  resetPendingHydrationRestoreForTesting,
} from "@/stores/chats/chat-tab-pending-hydration-restore";
import { evictTileFindUiForEpic } from "@/stores/tile-find/tile-find-store";
import {
  evictChatTurnMinimapActiveEntries,
  evictChatTurnMinimapActiveEntriesForEpic,
  restoreChatTurnMinimapActiveEntry,
  saveChatTurnMinimapActiveEntry,
} from "@/stores/chats/chat-turn-minimap-active-entry-store";
import { CHAT_A, SPEC_A } from "./canvas-test-fixtures";

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

/**
 * Ticket 15 review round 3: the canvas close sweep now resolves a removed
 * tile's durable identity from the REAL canvas tree (`node.type === "chat"`,
 * `node.id` as chatId, `tabsById[tabId].epicId`) - so these tests use
 * `CHAT_A` (a real chat-kind fixture), not `SPEC_A`, and `epicId` must be
 * whichever epic the test actually opened the tab under (the sweep would
 * resolve nothing for a mismatched epicId).
 */
function identityFor(epicId: string): ChatTabPersistenceIdentity {
  return {
    tileInstanceId: CHAT_A.instanceId,
    epicId,
    chatId: CHAT_A.id,
  };
}

function seedTicket5PerTabState(epicId: string): void {
  const identity = identityFor(epicId);
  saveChatTabState({
    identity,
    mode: "free-scrolling",
    anchorMessageId: "msg-seed",
    anchorIndex: 0,
    offset: 24,
  });
  rememberPendingHydrationRestore(identity, {
    mode: "free-scrolling",
    anchorMessageId: "msg-pending",
    anchorIndex: 1,
    offset: 12,
  });
  getOrCreateActivityGroupOpenStore(identity)
    .getState()
    .setOpen("activity-g1", true);
  getOrCreateA2AOpenStore(identity).getState().setSentOpen("a2a-sent", true);
  useToolOpenStore.getState().setOpen(CHAT_A.instanceId, "tool-1", true);
  // Ticket 15 review round 3: the sweep's promotion is a no-op for a tab
  // scope that was never marked initialized (see
  // `chat-scoped-open-store-dual-key.ts`'s doc comment) - mark it here to
  // simulate a component that actually mounted and seeded this tab this
  // session, same as the real `useChatScopedOpenStoreDualKeySeed` hook would.
  toolOpenInitializedScopes.add(CHAT_A.instanceId);
  useSubagentOpenStore.getState().setOpen(CHAT_A.instanceId, "sub-1", true);
  subagentOpenInitializedScopes.add(CHAT_A.instanceId);
  saveChatTurnMinimapActiveEntry(identity, "msg-seed");
  // F4: models a chat tile whose find bar was open when it switched away
  // (unregistered while live, so scheduleUiReclaim left this `ui` entry in
  // place) - the sweep below is the ONLY thing that can ever reclaim it now.
  useTileFindStore.setState((state) => ({
    uiByTileInstanceId: {
      ...state.uiByTileInstanceId,
      [CHAT_A.instanceId]: SEEDED_TILE_FIND_UI,
    },
  }));
}

function expectTicket5PerTabStatePresent(epicId: string): void {
  const identity = identityFor(epicId);
  expect(peekSavedChatTabState(identity) !== null).toBe(true);
  expect(restoreChatTabState(identity, []).mode).toBe("free-scrolling");
  expect(
    getOrCreateActivityGroupOpenStore(identity)
      .getState()
      .openIds.has("activity-g1"),
  ).toBe(true);
  expect(
    getOrCreateA2AOpenStore(identity).getState().sentOpenIds.has("a2a-sent"),
  ).toBe(true);
  expect(
    useToolOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(CHAT_A.instanceId, "tool-1")),
  ).toBe(true);
  expect(
    useSubagentOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(CHAT_A.instanceId, "sub-1")),
  ).toBe(true);
  expect(
    useTileFindStore.getState().uiByTileInstanceId[CHAT_A.instanceId],
  ).toEqual(SEEDED_TILE_FIND_UI);
  expect(restoreChatTurnMinimapActiveEntry(identity)).toBe("msg-seed");
  expect(pendingHydrationRestore(identity)?.anchorMessageId).toBe(
    "msg-pending",
  );
}

function expectTicket5TabKeysEvicted(epicId: string): void {
  const identity = identityFor(epicId);
  // Tab-key half is gone (canvas close sweep). Durable chat-key half of the
  // dual-key registries still has the scroll/minimap/A2A/activity-group/
  // tool/subagent entries (ticket 15) - the SWEEP ITSELF promoted them
  // (round 3), not a separate component/hook commit - so a reopen via
  // getOrCreate re-seeds from durable.
  expect(
    useToolOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(CHAT_A.instanceId, "tool-1")),
  ).toBe(false);
  expect(
    useSubagentOpenStore
      .getState()
      .openIds.has(scopedChatOpenId(CHAT_A.instanceId, "sub-1")),
  ).toBe(false);
  expect(
    useTileFindStore.getState().uiByTileInstanceId[CHAT_A.instanceId],
  ).toBeUndefined();
  // Durable scroll + minimap still restore via chat-key after tab-key eviction.
  expect(peekSavedChatTabState(identity) !== null).toBe(true);
  expect(restoreChatTabState(identity, []).mode).toBe("free-scrolling");
  expect(restoreChatTurnMinimapActiveEntry(identity)).toBe("msg-seed");
  expect(pendingHydrationRestore(identity)).toBeNull();
  // A2A / activity-group registries: getOrCreate after tab-key eviction
  // builds a fresh store seeded from the durable snapshot the sweep wrote.
  expect(
    getOrCreateActivityGroupOpenStore(identity)
      .getState()
      .openIds.has("activity-g1"),
  ).toBe(true);
  expect(
    getOrCreateA2AOpenStore(identity).getState().sentOpenIds.has("a2a-sent"),
  ).toBe(true);
  // Ticket 15 review round 3: the sweep's promotion for tool/subagent must
  // also have re-seeded a fresh mount - simulate one via getOrCreate-style
  // durable read is not directly exposed for these two (global stores), so
  // this is asserted through the dual-key test suite instead; here we only
  // confirm the tab-key side is gone and the durable-backed registries
  // above answer correctly, matching the ticket-5 sweep contract.
}

// Ticket 15 review round 3: uses the individual (non-tombstoning) per-epic
// evict functions directly, NOT the orchestrated
// `evictChatTabPersistenceForEpic` - that one is a TERMINAL deletion (it
// tombstones the epic prefix, per the round-3 fence), which would
// permanently block the sweep's own promotion inside the actual test if
// used here for mere test-isolation cleanup between runs.
function clearTicket5PerTabState(instanceId: string, epicId: string): void {
  evictChatTabState([instanceId]);
  evictActivityGroupOpenStores([instanceId]);
  evictA2AOpenStores([instanceId]);
  evictChatTurnMinimapActiveEntries([instanceId]);
  toolOpenInitializedScopes.delete(instanceId);
  subagentOpenInitializedScopes.delete(instanceId);
  evictChatTabStateForEpic(epicId);
  evictActivityGroupOpenStoresForEpic(epicId);
  evictA2AOpenStoresForEpic(epicId);
  evictToolOpenStoresForEpic(epicId);
  evictSubagentOpenStoresForEpic(epicId);
  evictTileFindUiForEpic(epicId);
  evictChatTurnMinimapActiveEntriesForEpic(epicId);
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
  evictChatTurnMinimapActiveEntries([SPEC_A.instanceId]);
  clearTicket5PerTabState(CHAT_A.instanceId, "epic-t5-evict");
  clearTicket5PerTabState(CHAT_A.instanceId, "epic-t5-hide");
  useTileFindStore.getState().resetForTests();
  resetPendingHydrationRestoreForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  useToolOpenStore.setState({ openIds: new Set() });
  useSubagentOpenStore.setState({ openIds: new Set() });
  evictChatTabState([SPEC_A.instanceId]);
  evictActivityGroupOpenStores([SPEC_A.instanceId]);
  evictA2AOpenStores([SPEC_A.instanceId]);
  evictChatTurnMinimapActiveEntries([SPEC_A.instanceId]);
  clearTicket5PerTabState(CHAT_A.instanceId, "epic-t5-evict");
  clearTicket5PerTabState(CHAT_A.instanceId, "epic-t5-hide");
  useTileFindStore.getState().resetForTests();
  resetPendingHydrationRestoreForTesting();
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
  it("evicts tab-key chat-tab-state, activity-group/A2A registries, tool/subagent scopes, and tile-find ui on permanent close - AND the sweep itself promotes durable state (ticket 15 review round 3)", () => {
    const epicId = "epic-t5-evict";
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(epicId, "Evict Ticket5");
    store.openTileInTab(tabId, CHAT_A);
    seedTicket5PerTabState(epicId);
    expectTicket5PerTabStatePresent(epicId);

    useEpicCanvasStore.getState().closeTabsForEpics([epicId]);

    expectTicket5TabKeysEvicted(epicId);
  });

  it("preserves chat-tab-state, activity-group/A2A registries, tool/subagent scopes, and tile-find ui across hide-for-reopen", () => {
    const epicId = "epic-t5-hide";
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(epicId, "Hide Ticket5");
    store.openTileInTab(tabId, CHAT_A);
    seedTicket5PerTabState(epicId);

    // closeTab keeps the canvas/tiles live for reopen - same as anchors.
    store.closeTab(tabId);

    expectTicket5PerTabStatePresent(epicId);
  });
});
