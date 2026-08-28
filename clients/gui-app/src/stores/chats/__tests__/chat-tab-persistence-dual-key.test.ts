/**
 * Ticket 15 (decision #29): dual-key persistence pins - unit-level coverage
 * for the scroll cache, the other five registries, eviction, multi-view, and
 * stale-anchor nearest-neighbor. Component-level streaming / composer-resize
 * / restore-first pins live in chat-messages.test.tsx.
 *
 * Ticket 15 review round 3 (mandated simplification): the durable COMMIT
 * moved from per-hook/component unmounts to the canvas close sweep's
 * promotion choke point (store.ts - see its own tests in
 * `store-scroll-anchor-eviction.test.ts` for the end-to-end path through
 * the REAL sweep). This file's "reopen-after-close" pins simulate that
 * promotion directly via each registry's own `promoteXToDurable` function
 * (unit-level, no canvas store involved) - complementary to, not a
 * duplicate of, the canvas-level integration test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  evictChatTabState,
  evictChatTabStateForEpic,
  peekSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import {
  chatTabPersistenceChatKey,
  chatTabPersistenceTabKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";
import { isChatKeyTombstoned } from "@/stores/chats/chat-tab-persistence-tombstone";
import {
  evictA2AOpenStores,
  evictA2AOpenStoresForEpic,
  getOrCreateA2AOpenStore,
  promoteA2AOpenStoreToDurable,
} from "@/stores/chats/a2a-open-store-context";
import {
  evictActivityGroupOpenStores,
  evictActivityGroupOpenStoresForEpic,
  getOrCreateActivityGroupOpenStore,
  promoteActivityGroupOpenStoreToDurable,
} from "@/stores/chats/activity-group-open-store-core";
import {
  evictToolOpenStoresForEpic,
  promoteToolOpenToDurable,
  toolOpenDurableCache,
  toolOpenInitializedScopes,
  useToolOpenStore,
} from "@/stores/chats/tool-open-store";
import {
  evictSubagentOpenStoresForEpic,
  promoteSubagentOpenToDurable,
  subagentOpenDurableCache,
  subagentOpenInitializedScopes,
  useSubagentOpenStore,
} from "@/stores/chats/subagent-open-store";
import { useChatScopedOpenStoreDualKeySeed } from "@/stores/chats/chat-scoped-open-store-dual-key";
import { evictChatTabPersistenceForChat } from "@/stores/chats/chat-tab-persistence-eviction";
import { evictTileFindUi, useTileFindStore } from "@/stores/tile-find";
import {
  evictTileFindUiForChat,
  evictTileFindUiForEpic,
  promoteTileFindUiToDurable,
} from "@/stores/tile-find/tile-find-store";
import type { TileFindAdapter, TileFindCapability } from "@/stores/tile-find";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

const EPIC = "epic-t15";
const CHAT = "chat-t15";

function identity(
  tileInstanceId: string,
  epicId: string,
  chatId: string,
): ChatTabPersistenceIdentity {
  return { tileInstanceId, epicId, chatId };
}

function chatIdIdentity(tileInstanceId: string): ChatTabPersistenceIdentity {
  return identity(tileInstanceId, EPIC, CHAT);
}

function makeMessages(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage(index, index % 2 === 0 ? "user" : "assistant"),
  );
}

const FIND_CAPABILITY: ReadonlySet<TileFindCapability> = new Set(["find"]);

function createNoopAdapter(tileInstanceId: string): TileFindAdapter {
  return {
    tileInstanceId,
    tileKind: "chat",
    replace: null,
    getSnapshot: () => ({
      requestId: 0,
      status: "idle",
      capabilities: FIND_CAPABILITY,
      query: "",
      matchCase: false,
      replaceText: "",
      current: 0,
      total: 0,
      coverageMessage: null,
      errorMessage: null,
      activeUnitId: null,
      exactHighlight: "none",
    }),
    subscribe: () => () => undefined,
    search: () => undefined,
    next: () => undefined,
    previous: () => undefined,
    clear: () => undefined,
  };
}

// Every non-eviction test in this file shares (EPIC, CHAT) for its durable
// key - the two dedicated eviction/tombstone tests below use their OWN
// chatId so a tombstone they set never blocks any other test's writes
// (`evictChatTabPersistenceForChat` tombstones by EXACT chat-key, terminal
// until something re-opens that exact identity - ticket 15 review round 3).
const DELETE_SINGLE_CHAT = "chat-t15-delete-single";
const DELETE_ALL_REGISTRIES_CHAT = "chat-t15-delete-all-registries";

function clearEpicDurableStateForTests(epicId: string): void {
  // Ticket 15 review round 3: uses the individual (non-tombstoning) evict
  // functions - `evictChatTabPersistenceForEpic` is now a TERMINAL
  // deletion (it tombstones the epic prefix), which would permanently
  // block every other test sharing this epicId if used for mere
  // test-isolation cleanup.
  evictChatTabStateForEpic(epicId);
  evictA2AOpenStoresForEpic(epicId);
  evictActivityGroupOpenStoresForEpic(epicId);
  evictToolOpenStoresForEpic(epicId);
  evictSubagentOpenStoresForEpic(epicId);
  evictTileFindUiForEpic(epicId);
}

beforeEach(() => {
  useToolOpenStore.setState({ openIds: new Set() });
  useSubagentOpenStore.setState({ openIds: new Set() });
  useTileFindStore.getState().resetForTests();
});

afterEach(() => {
  // Sweep every tab/chat key this suite may have touched so suites share
  // module-scope caches cleanly.
  for (const id of [
    "pane-a",
    "pane-b",
    "reopen-old",
    "reopen-new",
    "multi-a",
    "multi-b",
    "sweep-a",
    "stale-a",
    "reg-scroll",
    "reg-a2a",
    "reg-activity",
    "reg-tool",
    "reg-sub",
    "reg-find",
    "delete-single-a",
    "delete-all-registries-a",
    "f2-close-a",
    "f2-reopen-a",
    "f2-multi-a",
    "f2-multi-b",
    "close-order-a",
    "close-order-b",
    "close-order-reopen",
    "close-order-reopen-find",
  ]) {
    evictChatTabState([id]);
    evictA2AOpenStores([id]);
    evictActivityGroupOpenStores([id]);
    evictTileFindUi([id]);
    toolOpenInitializedScopes.delete(id);
    subagentOpenInitializedScopes.delete(id);
  }
  clearEpicDurableStateForTests(EPIC);
  clearEpicDurableStateForTests("epic-other");
  clearEpicDurableStateForTests("epic-t15-close-order");
  useToolOpenStore.setState({ openIds: new Set() });
  useSubagentOpenStore.setState({ openIds: new Set() });
  useTileFindStore.getState().resetForTests();
});

describe("chat-tab-persistence-key", () => {
  it("derives stable tab and chat keys", () => {
    const id = chatIdIdentity("tile-1");
    expect(chatTabPersistenceTabKey(id)).toBe("tile-1");
    expect(chatTabPersistenceChatKey(id)).toBe(`${EPIC}:${CHAT}`);
  });
});

describe("ticket 15 dual-key scroll cache", () => {
  it("RESTORE-FIRST: saved following-end and free-scrolling both round-trip (tab-key)", () => {
    const messages = makeMessages(6);
    const id = chatIdIdentity("pane-a");

    saveChatTabState({
      identity: id,
      mode: "following-end",
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    });
    expect(peekSavedChatTabState(id) !== null).toBe(true);
    expect(
      restoreChatTabState(
        id,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "following-end",
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    });

    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: messages[2]?.id ?? null,
      anchorIndex: 2,
      offset: 48,
    });
    expect(
      restoreChatTabState(
        id,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[2]?.id,
      anchorIndex: 2,
      offset: 48,
    });
  });

  it("RESTORE-FIRST via chat-key only (simulates reopen after tab eviction)", () => {
    const messages = makeMessages(6);
    const closed = chatIdIdentity("reopen-old");
    saveChatTabState({
      identity: closed,
      mode: "free-scrolling",
      anchorMessageId: messages[3]?.id ?? null,
      anchorIndex: 3,
      offset: 12,
    });
    // Canvas close sweep: tab-key only.
    evictChatTabState([closed.tileInstanceId]);
    // New open mints a fresh tileInstanceId for the same (epic, chat).
    const reopened = chatIdIdentity("reopen-new");
    expect(peekSavedChatTabState(reopened) !== null).toBe(true);
    expect(
      restoreChatTabState(
        reopened,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[3]?.id,
      anchorIndex: 3,
      offset: 12,
    });
  });

  it("multi-view: independent tab-keys; durable chat-key is last-writer-wins", () => {
    const messages = makeMessages(6);
    const viewA = chatIdIdentity("multi-a");
    const viewB = chatIdIdentity("multi-b");

    saveChatTabState({
      identity: viewA,
      mode: "free-scrolling",
      anchorMessageId: messages[1]?.id ?? null,
      anchorIndex: 1,
      offset: 10,
    });
    saveChatTabState({
      identity: viewB,
      mode: "free-scrolling",
      anchorMessageId: messages[4]?.id ?? null,
      anchorIndex: 4,
      offset: 20,
    });

    // While both stay open, each tab-key restores its own entry.
    expect(
      restoreChatTabState(
        viewA,
        messages.map((message) => message.id),
      ).anchorMessageId,
    ).toBe(messages[1]?.id);
    expect(
      restoreChatTabState(
        viewB,
        messages.map((message) => message.id),
      ).anchorMessageId,
    ).toBe(messages[4]?.id);

    // Last writer was viewB - a brand-new third view of the same chat
    // restores viewB's durable entry after both tab-keys are gone.
    evictChatTabState([viewA.tileInstanceId, viewB.tileInstanceId]);
    const third = chatIdIdentity("reopen-new");
    expect(
      restoreChatTabState(
        third,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[4]?.id,
      anchorIndex: 4,
      offset: 20,
    });
  });

  it("sweep evicts tab-keys only, never chat-keys", () => {
    const messages = makeMessages(4);
    const id = chatIdIdentity("sweep-a");
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id ?? null,
      anchorIndex: 0,
      offset: 8,
    });
    evictChatTabState([id.tileInstanceId]);
    // Same identity still hasSaved via durable; a different tileInstanceId
    // of the same chat also restores.
    expect(peekSavedChatTabState(id) !== null).toBe(true);
    expect(
      restoreChatTabState(
        chatIdIdentity("reopen-new"),
        messages.map((message) => message.id),
      ).mode,
    ).toBe("free-scrolling");
  });

  it("chat-delete eviction drops the durable chat-key entry and tombstones it (ticket 15 review round 3)", () => {
    const messages = makeMessages(4);
    const id = identity("delete-single-a", EPIC, DELETE_SINGLE_CHAT);
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id ?? null,
      anchorIndex: 0,
      offset: 8,
    });
    evictChatTabState([id.tileInstanceId]);
    expect(peekSavedChatTabState(id) !== null).toBe(true);

    evictChatTabPersistenceForChat({
      epicId: EPIC,
      chatId: DELETE_SINGLE_CHAT,
    });
    expect(peekSavedChatTabState(id) !== null).toBe(false);
    expect(isChatKeyTombstoned(chatTabPersistenceChatKey(id))).toBe(true);

    const reopened = identity("reopen-new", EPIC, DELETE_SINGLE_CHAT);
    expect(
      restoreChatTabState(
        reopened,
        messages.map((message) => message.id),
      ).mode,
    ).toBe("following-end");
    expect(peekSavedChatTabState(reopened) !== null).toBe(false);

    // Terminal regardless of who writes DURABLE state after the delete -
    // the whole point of the tombstone (round-3 finding: a late-arriving
    // sweep promotion used to resurrect a just-deleted chat). A save while
    // this identity is still live legitimately writes the ephemeral
    // tab-key entry (real-time scroll tracking for whatever view is
    // showing "reopened" right now - `saveChatTabState` is not the mount
    // path that clears the tombstone), but the durable half of that same
    // save is fenced, so once that view ALSO closes without a genuine
    // chat-messages remount, nothing durable survives to restore from.
    saveChatTabState({
      identity: reopened,
      mode: "free-scrolling",
      anchorMessageId: messages[1]?.id ?? null,
      anchorIndex: 1,
      offset: 99,
    });
    expect(peekSavedChatTabState(reopened) !== null).toBe(true);
    evictChatTabState([reopened.tileInstanceId]);
    expect(peekSavedChatTabState(reopened) !== null).toBe(false);
  });

  it("stale-anchor nearest-neighbor: clamps index below, above, and empty", () => {
    const messages = makeMessages(5);
    const id = chatIdIdentity("stale-a");

    // Index below range (negative) clamps to 0.
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: "gone-low",
      anchorIndex: -3,
      offset: 40,
    });
    expect(
      restoreChatTabState(
        id,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id,
      anchorIndex: 0,
      offset: 0,
    });

    // Index above range clamps to last row.
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: "gone-high",
      anchorIndex: 99,
      offset: 40,
    });
    expect(
      restoreChatTabState(
        id,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[4]?.id,
      anchorIndex: 4,
      offset: 0,
    });

    // Mid-list gone message with a recorded index lands on that neighbor.
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: "gone-mid",
      anchorIndex: 2,
      offset: 16,
    });
    expect(
      restoreChatTabState(
        id,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[2]?.id,
      anchorIndex: 2,
      offset: 0,
    });

    // Empty transcript: no neighbor to land on.
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: "gone-empty",
      anchorIndex: 2,
      offset: 16,
    });
    expect(restoreChatTabState(id, [])).toEqual({
      mode: "free-scrolling",
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    });
  });
});

describe("ticket 15 dual-key registries (round 3: sweep-simulated promotion)", () => {
  it("scroll cache: reopen-after-close restores free-scrolling", () => {
    const messages = makeMessages(3);
    const closed = chatIdIdentity("reg-scroll");
    saveChatTabState({
      identity: closed,
      mode: "free-scrolling",
      anchorMessageId: messages[1]?.id ?? null,
      anchorIndex: 1,
      offset: 7,
    });
    evictChatTabState([closed.tileInstanceId]);
    expect(
      restoreChatTabState(
        chatIdIdentity("reopen-new"),
        messages.map((message) => message.id),
      ).offset,
    ).toBe(7);
  });

  it("A2A open: reopen-after-close restores sent open ids", () => {
    const closed = chatIdIdentity("reg-a2a");
    getOrCreateA2AOpenStore(closed).getState().setSentOpen("sent-1", true);
    // Simulates the canvas sweep's promotion (store.ts), BEFORE tab-key
    // eviction - round 3's ONE close-commit choke point.
    promoteA2AOpenStoreToDurable(closed);
    evictA2AOpenStores([closed.tileInstanceId]);
    const reopened = chatIdIdentity("reopen-new");
    expect(
      getOrCreateA2AOpenStore(reopened).getState().sentOpenIds.has("sent-1"),
    ).toBe(true);
  });

  it("activity-group open: reopen-after-close restores open ids", () => {
    const closed = chatIdIdentity("reg-activity");
    getOrCreateActivityGroupOpenStore(closed)
      .getState()
      .setOpen("group-1", true);
    promoteActivityGroupOpenStoreToDurable(closed);
    evictActivityGroupOpenStores([closed.tileInstanceId]);
    const reopened = chatIdIdentity("reopen-new");
    expect(
      getOrCreateActivityGroupOpenStore(reopened)
        .getState()
        .openIds.has("group-1"),
    ).toBe(true);
  });

  it("tool open: reopen-after-close restores segment ids via the sweep's promotion", () => {
    const closed = chatIdIdentity("reg-tool");
    useToolOpenStore
      .getState()
      .setOpen(closed.tileInstanceId, "tool-seg", true);
    toolOpenInitializedScopes.add(closed.tileInstanceId);
    promoteToolOpenToDurable(closed);
    useToolOpenStore.getState().reset(closed.tileInstanceId);
    toolOpenInitializedScopes.delete(closed.tileInstanceId);

    const reopened = chatIdIdentity("reopen-new");
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        reopened,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    expect(
      useToolOpenStore
        .getState()
        .openIds.has(`${reopened.tileInstanceId}\0tool-seg`),
    ).toBe(true);
  });

  it("subagent open: reopen-after-close restores segment ids via the sweep's promotion", () => {
    const closed = chatIdIdentity("reg-sub");
    useSubagentOpenStore
      .getState()
      .setOpen(closed.tileInstanceId, "sub-seg", true);
    subagentOpenInitializedScopes.add(closed.tileInstanceId);
    promoteSubagentOpenToDurable(closed);
    useSubagentOpenStore.getState().reset(closed.tileInstanceId);
    subagentOpenInitializedScopes.delete(closed.tileInstanceId);

    const reopened = chatIdIdentity("reopen-new");
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useSubagentOpenStore,
        reopened,
        subagentOpenDurableCache,
        subagentOpenInitializedScopes,
      ),
    );
    expect(
      useSubagentOpenStore
        .getState()
        .openIds.has(`${reopened.tileInstanceId}\0sub-seg`),
    ).toBe(true);
  });

  it("tile-find session: reopen-after-close seeds ui from the sweep's promotion", () => {
    const closedId = "reg-find";
    const adapter = createNoopAdapter(closedId);
    const unregister = useTileFindStore.getState().registerTarget({
      tileInstanceId: closedId,
      contentId: CHAT,
      viewTabId: "view-1",
      tileId: "pane-1",
      epicId: EPIC,
      tileKind: "chat",
      isEligible: true,
      adapter,
    });
    useTileFindStore.getState().setQuery(closedId, "needle");
    useTileFindStore.getState().openForTile(closedId);
    // Production order: the canvas sweep's promotion (reading
    // `uiByTileInstanceId` directly - round 3 dropped the
    // `targetsByTileInstanceId` dependency the F1/F2/F3 round had) runs
    // BEFORE `evictTileFindUi`, which itself runs BEFORE the adapter's own
    // `unregister()` (React unmount, fires last).
    promoteTileFindUiToDurable(chatIdIdentity(closedId));
    evictTileFindUi([closedId]);
    unregister();
    expect(
      useTileFindStore.getState().uiByTileInstanceId[closedId],
    ).toBeUndefined();

    const reopenedId = "reopen-new";
    useTileFindStore.getState().registerTarget({
      tileInstanceId: reopenedId,
      contentId: CHAT,
      viewTabId: "view-1",
      tileId: "pane-2",
      epicId: EPIC,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter(reopenedId),
    });
    const ui = useTileFindStore.getState().uiByTileInstanceId[reopenedId];
    expect(ui?.query).toBe("needle");
    expect(ui?.isOpen).toBe(true);

    // Chat-delete eviction must drop durable so a third open does not restore.
    evictTileFindUiForChat({ epicId: EPIC, chatId: CHAT });
    evictTileFindUi([reopenedId]);
    useTileFindStore.getState().resetForTests();
    useTileFindStore.getState().registerTarget({
      tileInstanceId: "reg-find-after-delete",
      contentId: CHAT,
      viewTabId: "view-1",
      tileId: "pane-3",
      epicId: EPIC,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter("reg-find-after-delete"),
    });
    expect(
      useTileFindStore.getState().uiByTileInstanceId["reg-find-after-delete"]
        ?.query,
    ).toBe("");
  });

  it("orchestrated chat-delete eviction clears every durable registry (ticket 15 review F7)", () => {
    const id = identity(
      "delete-all-registries-a",
      EPIC,
      DELETE_ALL_REGISTRIES_CHAT,
    );
    const messages = makeMessages(2);
    saveChatTabState({
      identity: id,
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id ?? null,
      anchorIndex: 0,
      offset: 1,
    });
    getOrCreateA2AOpenStore(id).getState().setSentOpen("s", true);
    promoteA2AOpenStoreToDurable(id);
    getOrCreateActivityGroupOpenStore(id).getState().setOpen("g", true);
    promoteActivityGroupOpenStoreToDurable(id);
    toolOpenDurableCache.set(id, new Set(["t"]));
    subagentOpenDurableCache.set(id, new Set(["u"]));
    // tile-find durable is chat-keyed by (epicId, contentId) - contentId is
    // `id.chatId` for a chat tile; register a real target so the sweep's
    // promotion has something to read.
    const findAdapter = createNoopAdapter(id.tileInstanceId);
    useTileFindStore.getState().registerTarget({
      tileInstanceId: id.tileInstanceId,
      contentId: id.chatId,
      viewTabId: "view-1",
      tileId: "pane-1",
      epicId: id.epicId,
      tileKind: "chat",
      isEligible: true,
      adapter: findAdapter,
    });
    useTileFindStore.getState().setQuery(id.tileInstanceId, "all");
    promoteTileFindUiToDurable(id);

    evictChatTabState([id.tileInstanceId]);
    evictA2AOpenStores([id.tileInstanceId]);
    evictActivityGroupOpenStores([id.tileInstanceId]);
    evictTileFindUi([id.tileInstanceId]);

    // Sanity: before the chat-delete call, every durable registry has data -
    // otherwise the assertions below would pass vacuously.
    const preDeleteReopen = identity(
      "reopen-pre-delete",
      EPIC,
      DELETE_ALL_REGISTRIES_CHAT,
    );
    expect(peekSavedChatTabState(preDeleteReopen) !== null).toBe(true);
    expect(
      getOrCreateA2AOpenStore(preDeleteReopen).getState().sentOpenIds.has("s"),
    ).toBe(true);
    expect(
      getOrCreateActivityGroupOpenStore(preDeleteReopen)
        .getState()
        .openIds.has("g"),
    ).toBe(true);
    expect(toolOpenDurableCache.get(preDeleteReopen)?.has("t")).toBe(true);
    expect(subagentOpenDurableCache.get(preDeleteReopen)?.has("u")).toBe(true);
    useTileFindStore.getState().registerTarget({
      tileInstanceId: "reopen-pre-delete-find",
      contentId: id.chatId,
      viewTabId: "view-1",
      tileId: "pane-2",
      epicId: id.epicId,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter("reopen-pre-delete-find"),
    });
    expect(
      useTileFindStore.getState().uiByTileInstanceId["reopen-pre-delete-find"]
        ?.query,
    ).toBe("all");

    evictChatTabPersistenceForChat({ epicId: id.epicId, chatId: id.chatId });

    const reopened = identity("reopen-new", EPIC, DELETE_ALL_REGISTRIES_CHAT);
    expect(peekSavedChatTabState(reopened) !== null).toBe(false);
    expect(
      getOrCreateA2AOpenStore(reopened).getState().sentOpenIds.has("s"),
    ).toBe(false);
    expect(
      getOrCreateActivityGroupOpenStore(reopened).getState().openIds.has("g"),
    ).toBe(false);
    expect(toolOpenDurableCache.get(reopened)).toBeUndefined();
    expect(subagentOpenDurableCache.get(reopened)).toBeUndefined();
    useTileFindStore.getState().registerTarget({
      tileInstanceId: "reopen-post-delete-find",
      contentId: id.chatId,
      viewTabId: "view-1",
      tileId: "pane-3",
      epicId: id.epicId,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter("reopen-post-delete-find"),
    });
    expect(
      useTileFindStore.getState().uiByTileInstanceId["reopen-post-delete-find"]
        ?.query,
    ).toBe("");
  });
});

describe("ticket 15 review round 3: useChatScopedOpenStoreDualKeySeed (F2)", () => {
  it("close-then-reopen: expansion promoted at close (via the sweep) survives and seeds the reopened scope", () => {
    const closed = chatIdIdentity("f2-close-a");
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        closed,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    act(() => {
      useToolOpenStore.getState().setOpen(closed.tileInstanceId, "seg-1", true);
    });
    expect(
      useToolOpenStore
        .getState()
        .openIds.has(`${closed.tileInstanceId}\0seg-1`),
    ).toBe(true);

    // Production order (round 3): the sweep promotes THEN resets, all
    // synchronously, before this tab's own component (if any) ever
    // unmounts - simulate exactly that here, with no hook cleanup involved.
    promoteToolOpenToDurable(closed);
    useToolOpenStore.getState().reset(closed.tileInstanceId);
    toolOpenInitializedScopes.delete(closed.tileInstanceId);

    const reopened = chatIdIdentity("f2-reopen-a");
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        reopened,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    expect(
      useToolOpenStore
        .getState()
        .openIds.has(`${reopened.tileInstanceId}\0seg-1`),
    ).toBe(true);
  });

  it("multi-view independence: A has only 'a', B has only 'b', and A's remount is not polluted by B's later durable write", () => {
    const viewA = chatIdIdentity("f2-multi-a");
    const viewB = chatIdIdentity("f2-multi-b");

    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        viewA,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        viewB,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    act(() => {
      useToolOpenStore.getState().setOpen(viewA.tileInstanceId, "a", true);
      useToolOpenStore.getState().setOpen(viewB.tileInstanceId, "b", true);
    });

    // A has only 'a', not 'b'; B has only 'b', not 'a' - no cross-pollution
    // while both stay live.
    expect(
      useToolOpenStore.getState().openIds.has(`${viewA.tileInstanceId}\0a`),
    ).toBe(true);
    expect(
      useToolOpenStore.getState().openIds.has(`${viewA.tileInstanceId}\0b`),
    ).toBe(false);
    expect(
      useToolOpenStore.getState().openIds.has(`${viewB.tileInstanceId}\0b`),
    ).toBe(true);
    expect(
      useToolOpenStore.getState().openIds.has(`${viewB.tileInstanceId}\0a`),
    ).toBe(false);

    // A "switches away" (its own scope is left untouched - only a real
    // close resets it, which does not happen here).
    expect(
      useToolOpenStore.getState().openIds.has(`${viewA.tileInstanceId}\0a`),
    ).toBe(true);

    // THEN B genuinely closes - the sweep promotes B's state, overwriting
    // the shared durable chat-key entry with 'b' (last-writer-wins is
    // correct: B's close really is the most recent event).
    promoteToolOpenToDurable(viewB);
    useToolOpenStore.getState().reset(viewB.tileInstanceId);
    toolOpenInitializedScopes.delete(viewB.tileInstanceId);

    // A remounts (switch-away-then-back, SAME tileInstanceId, still holding
    // its own intact live 'a'). Without the "fresh scope only" seed guard,
    // this reseed would read the shared durable entry (now 'b', from B's
    // later promotion) and union it on top of A's still-live 'a'.
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        viewA,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    expect(
      useToolOpenStore.getState().openIds.has(`${viewA.tileInstanceId}\0a`),
    ).toBe(true);
    expect(
      useToolOpenStore.getState().openIds.has(`${viewA.tileInstanceId}\0b`),
    ).toBe(false);
  });

  it("genuine collapse-to-zero: a scope that was seeded then explicitly emptied promotes as empty, not stale non-empty (round 3 finding)", () => {
    const closed = chatIdIdentity("f2-close-a");
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        closed,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    act(() => {
      useToolOpenStore.getState().setOpen(closed.tileInstanceId, "seg-1", true);
    });
    act(() => {
      // The reader collapses everything back down before closing.
      useToolOpenStore
        .getState()
        .setOpen(closed.tileInstanceId, "seg-1", false);
    });
    expect(
      useToolOpenStore
        .getState()
        .openIds.has(`${closed.tileInstanceId}\0seg-1`),
    ).toBe(false);

    promoteToolOpenToDurable(closed);
    expect(toolOpenDurableCache.get(closed)).toEqual(new Set());

    useToolOpenStore.getState().reset(closed.tileInstanceId);
    toolOpenInitializedScopes.delete(closed.tileInstanceId);

    const reopened = chatIdIdentity("f2-reopen-a");
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        reopened,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    expect(
      useToolOpenStore
        .getState()
        .openIds.has(`${reopened.tileInstanceId}\0seg-1`),
    ).toBe(false);
  });
});

// Ticket 15 review round 4 (finding 5): the round-3 version of this test
// invoked each registry's `promoteXToDurable` MANUALLY, in the order the
// sweep is supposed to call them - it proved every registry's own
// last-write-wins property, but never actually drove the canvas's real
// close action, so it could not catch a regression that severed the
// canvas-to-promotion link (e.g. the sweep silently dropping its promotion
// loop, or reordering it after eviction - see `store.ts`'s own comment on
// why promotion must run BEFORE eviction). This version drives
// `useEpicCanvasStore.getState().closeTabsForEpics(...)` - the SAME action
// a real tab close uses - twice, at genuinely different times, so "B
// closes, A closes LAST" is two separate sweep invocations, not two
// promotions manually ordered by the test.
function closeOrderChatRef(instanceId: string, chatId: string): EpicNodeRef {
  return {
    id: chatId,
    instanceId,
    type: "chat",
    name: "Close Order Chat",
    hostId: "test-host",
  };
}

describe("ticket 15 review round 4: real close order drives the canvas sweep (F3/finding 5)", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("A writes, B writes, B closes (own sweep), A closes LAST (own sweep) -> A's durable commit wins", () => {
    const epicId = "epic-t15-close-order-real";
    const chatId = "chat-t15-close-order-real";
    const messages = makeMessages(4);

    // --- View B opens, writes across every registry, then closes via
    // the REAL canvas close path.
    const tabB = useEpicCanvasStore.getState().openEpicTab(epicId, "View B");
    useEpicCanvasStore
      .getState()
      .openTileInTab(tabB, closeOrderChatRef("close-order-b", chatId));
    const viewB = identity("close-order-b", epicId, chatId);
    saveChatTabState({
      identity: viewB,
      mode: "free-scrolling",
      anchorMessageId: messages[2]?.id ?? null,
      anchorIndex: 2,
      offset: 20,
    });
    getOrCreateA2AOpenStore(viewB).getState().setSentOpen("a2a-b", true);
    getOrCreateActivityGroupOpenStore(viewB)
      .getState()
      .setOpen("group-b", true);
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        viewB,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useSubagentOpenStore,
        viewB,
        subagentOpenDurableCache,
        subagentOpenInitializedScopes,
      ),
    );
    act(() => {
      useToolOpenStore.getState().setOpen(viewB.tileInstanceId, "tool-b", true);
      useSubagentOpenStore
        .getState()
        .setOpen(viewB.tileInstanceId, "sub-b", true);
    });
    useTileFindStore.getState().registerTarget({
      tileInstanceId: viewB.tileInstanceId,
      contentId: chatId,
      viewTabId: tabB,
      tileId: "pane-b",
      epicId,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter(viewB.tileInstanceId),
    });
    useTileFindStore.getState().setQuery(viewB.tileInstanceId, "query-b");

    useEpicCanvasStore.getState().closeTabsForEpics([epicId]);

    // --- View A opens LATER (a new tab, same epic+chat), writes, then
    // closes via the REAL canvas close path too - its close is the
    // temporally LAST event, so its promotion must win.
    //
    // A's own `getOrCreate*`/seed calls below legitimately INHERIT B's
    // just-closed state (restore-first, decision #29 - the whole point of
    // this ticket) - a fresh A2A/activity-group/tool/subagent store for the
    // SAME chat starts from B's durable snapshot, not empty. So proving A's
    // LATER close wins isn't "does B's key vanish" (it wouldn't, even under
    // correct behavior, since A never touched it) - it's "does A's own
    // EXPLICIT undo of what it inherited survive its close." A closes each
    // of B's toggles it just inherited, then opens its own.
    const tabA = useEpicCanvasStore.getState().openEpicTab(epicId, "View A");
    useEpicCanvasStore
      .getState()
      .openTileInTab(tabA, closeOrderChatRef("close-order-a", chatId));
    const viewA = identity("close-order-a", epicId, chatId);
    saveChatTabState({
      identity: viewA,
      mode: "free-scrolling",
      anchorMessageId: messages[1]?.id ?? null,
      anchorIndex: 1,
      offset: 10,
    });
    getOrCreateA2AOpenStore(viewA).getState().setSentOpen("a2a-b", false);
    getOrCreateA2AOpenStore(viewA).getState().setSentOpen("a2a-a", true);
    getOrCreateActivityGroupOpenStore(viewA)
      .getState()
      .setOpen("group-b", false);
    getOrCreateActivityGroupOpenStore(viewA)
      .getState()
      .setOpen("group-a", true);
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useToolOpenStore,
        viewA,
        toolOpenDurableCache,
        toolOpenInitializedScopes,
      ),
    );
    renderHook(() =>
      useChatScopedOpenStoreDualKeySeed(
        useSubagentOpenStore,
        viewA,
        subagentOpenDurableCache,
        subagentOpenInitializedScopes,
      ),
    );
    act(() => {
      // Same restore-first inheritance as A2A/activity-group above - A's
      // fresh seed inherits B's just-promoted "tool-b"/"sub-b" segments, so
      // proving A's own close wins means explicitly closing what it
      // inherited before opening its own.
      useToolOpenStore
        .getState()
        .setOpen(viewA.tileInstanceId, "tool-b", false);
      useToolOpenStore.getState().setOpen(viewA.tileInstanceId, "tool-a", true);
      useSubagentOpenStore
        .getState()
        .setOpen(viewA.tileInstanceId, "sub-b", false);
      useSubagentOpenStore
        .getState()
        .setOpen(viewA.tileInstanceId, "sub-a", true);
    });
    useTileFindStore.getState().registerTarget({
      tileInstanceId: viewA.tileInstanceId,
      contentId: chatId,
      viewTabId: tabA,
      tileId: "pane-a",
      epicId,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter(viewA.tileInstanceId),
    });
    useTileFindStore.getState().setQuery(viewA.tileInstanceId, "query-a");

    useEpicCanvasStore.getState().closeTabsForEpics([epicId]);

    // A's own final promotion - driven by the REAL canvas close action, not
    // a manual promote call - wins on every registry, not B's, even though
    // B ALSO wrote and closed.
    const reopenedA = identity("close-order-reopen", epicId, chatId);
    expect(
      restoreChatTabState(
        reopenedA,
        messages.map((message) => message.id),
      ),
    ).toEqual({
      mode: "free-scrolling",
      anchorMessageId: messages[1]?.id,
      anchorIndex: 1,
      offset: 10,
    });
    expect(
      getOrCreateA2AOpenStore(reopenedA).getState().sentOpenIds.has("a2a-a"),
    ).toBe(true);
    expect(
      getOrCreateA2AOpenStore(reopenedA).getState().sentOpenIds.has("a2a-b"),
    ).toBe(false);
    expect(
      getOrCreateActivityGroupOpenStore(reopenedA)
        .getState()
        .openIds.has("group-a"),
    ).toBe(true);
    expect(
      getOrCreateActivityGroupOpenStore(reopenedA)
        .getState()
        .openIds.has("group-b"),
    ).toBe(false);
    expect(toolOpenDurableCache.get(reopenedA)?.has("tool-a")).toBe(true);
    expect(toolOpenDurableCache.get(reopenedA)?.has("tool-b")).toBe(false);
    expect(subagentOpenDurableCache.get(reopenedA)?.has("sub-a")).toBe(true);
    expect(subagentOpenDurableCache.get(reopenedA)?.has("sub-b")).toBe(false);
    useTileFindStore.getState().registerTarget({
      tileInstanceId: "close-order-reopen-find",
      contentId: chatId,
      viewTabId: "view-1",
      tileId: "pane-reopen",
      epicId,
      tileKind: "chat",
      isEligible: true,
      adapter: createNoopAdapter("close-order-reopen-find"),
    });
    expect(
      useTileFindStore.getState().uiByTileInstanceId["close-order-reopen-find"]
        ?.query,
    ).toBe("query-a");
  });
});
