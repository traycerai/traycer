import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as idbKeyval from "idb-keyval";
import { createStore, get as idbGet, set } from "idb-keyval";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { closeTab } from "@/stores/epics/canvas/actions";
import type { EpicCanvasState, EpicViewTab } from "@/stores/epics/canvas/types";
import {
  SPEC_A,
  SPEC_B,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { persistKey, tabRecoveryKey } from "@/lib/persist/keys";
import { tabItemId, type PersistedTabStripLayout } from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import {
  batchHeaderTabRecovery,
  configureTabRecoveryHistory,
  MAX_RECOVERY_ACTIONS,
  pruneRecoveryDraft,
  pruneRecoveryEpics,
  pruneRecoveryTiles,
  recordClosedCanvas,
  recordClosedHeaderTab,
  flushTabRecoveryHistory,
  resetTabRecoveryHistory,
  useTabRecoveryHistory,
  withoutTabRecovery,
  type ClosedHeaderTab,
  type TabRecoveryEntry,
} from "../history";

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>();
  return {
    ...actual,
    get: vi.fn(actual.get),
  };
});

const WINDOW_ONE = "recovery-window-one";
const WINDOW_TWO = "recovery-window-two";
const ACCOUNT_ONE = "recovery-account-one";
const ACCOUNT_TWO = "recovery-account-two";

function setWindow(windowId: string): void {
  Reflect.set(globalThis, "runnerHost", { windows: { windowId } });
}

function layoutForRefs(refs: ReadonlyArray<TabRef>): PersistedTabStripLayout {
  const first = refs.at(0);
  return {
    version: 2,
    items: refs.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
    activeItemId: first === undefined ? null : tabItemId(first),
    systemTabs: { history: null, settings: null },
    activationHistory: [],
  };
}

function draft(id: string): Extract<ClosedHeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    draftId: id,
    hostId: null,
    index: 0,
  };
}

function epicTab(epicId: string, tabId: string): EpicViewTab {
  return { epicId, tabId, name: epicId };
}

function canvasWithTwoTiles(): EpicCanvasState {
  return {
    root: pane("p1", [SPEC_A.instanceId, SPEC_B.instanceId]),
    activePaneId: "p1",
    tilesByInstanceId: {
      [SPEC_A.instanceId]: SPEC_A,
      [SPEC_B.instanceId]: SPEC_B,
    },
    sizesByGroupId: {},
  };
}

function emptyCanvas(): EpicCanvasState {
  return {
    root: null,
    activePaneId: null,
    tilesByInstanceId: {},
    sizesByGroupId: {},
  };
}

function canvasWithBlankAndSpec(): {
  readonly canvas: EpicCanvasState;
  readonly blankInstanceId: string;
} {
  const blank = makeBlankTileRef();
  return {
    canvas: {
      root: pane("p1", [blank.instanceId, SPEC_A.instanceId]),
      activePaneId: "p1",
      tilesByInstanceId: {
        [blank.instanceId]: blank,
        [SPEC_A.instanceId]: SPEC_A,
      },
      sizesByGroupId: {},
    },
    blankInstanceId: blank.instanceId,
  };
}

async function seedPersistedEntries(
  entries: readonly TabRecoveryEntry[],
): Promise<void> {
  await configureTabRecoveryHistory(null);
  await flushTabRecoveryHistory();
  const store = createStore(persistKey("tab-recovery"), "history");
  await set(
    tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE),
    { version: 2, entries },
    store,
  );
  setWindow(WINDOW_ONE);
  await configureTabRecoveryHistory(ACCOUNT_ONE);
}

async function prepareHistory(windowId: string): Promise<void> {
  await resetTabRecoveryHistory();
  installFreshIndexedDb();
  setWindow(windowId);
  await configureTabRecoveryHistory(null);
  await configureTabRecoveryHistory(ACCOUNT_ONE);
  useTabRecoveryHistory.setState({ entries: [], ready: true });
}

beforeEach(async () => {
  await prepareHistory(WINDOW_ONE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tab recovery history", () => {
  it("keeps the persisted journal intact across a failed same-identity hydration retry", async () => {
    const persistedOne = draft("persisted-one");
    const persistedTwo = draft("persisted-two");
    recordClosedHeaderTab(persistedOne);
    recordClosedHeaderTab(persistedTwo);
    await flushTabRecoveryHistory();

    const store = createStore(persistKey("tab-recovery"), "history");
    const key = tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE);
    const diskBeforeFailure = await idbGet<unknown>(key, store);
    expect(diskBeforeFailure).toEqual(expect.objectContaining({ version: 2 }));

    await resetTabRecoveryHistory();
    setWindow(WINDOW_ONE);
    vi.mocked(idbKeyval.get)
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"))
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"))
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"));
    await configureTabRecoveryHistory(ACCOUNT_ONE);

    expect(useTabRecoveryHistory.getState().ready).toBe(false);

    const pending = draft("pending-after-failure");
    recordClosedHeaderTab(pending);
    pruneRecoveryDraft(persistedTwo.draftId);

    // The failed restore must not persist the in-memory, incomplete view over
    // the last good disk snapshot, even when a close and permanent prune land
    // while the retry is waiting.
    expect(await idbGet<unknown>(key, store)).toEqual(diskBeforeFailure);

    await configureTabRecoveryHistory(ACCOUNT_ONE);
    await flushTabRecoveryHistory();

    const recoveredDraftIds = useTabRecoveryHistory
      .getState()
      .entries.flatMap((entry) =>
        entry.kind === "header"
          ? entry.items.flatMap((item) =>
              item.kind === "draft" ? [item.draftId] : [],
            )
          : [],
      );
    expect(recoveredDraftIds).toEqual([persistedOne.draftId, pending.draftId]);
    expect(useTabRecoveryHistory.getState().ready).toBe(true);
    const diskAfterRetry = await idbGet<unknown>(key, store);
    expect(diskAfterRetry).toEqual(expect.objectContaining({ version: 2 }));
    if (
      typeof diskAfterRetry !== "object" ||
      diskAfterRetry === null ||
      !("entries" in diskAfterRetry) ||
      !Array.isArray(diskAfterRetry.entries)
    ) {
      throw new Error("expected the retried journal to contain entries");
    }
    expect(diskAfterRetry.entries).toHaveLength(2);
  });

  it("automatically succeeds after one transient storage read failure", async () => {
    const recovered = draft("automatic-retry");
    const store = createStore(persistKey("tab-recovery"), "history");
    await set(
      tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE),
      {
        version: 2,
        entries: [
          { kind: "header", id: "automatic", bulk: false, items: [recovered] },
        ],
      },
      store,
    );

    await resetTabRecoveryHistory();
    setWindow(WINDOW_ONE);
    const get = vi.mocked(idbKeyval.get);
    get.mockClear();
    get.mockRejectedValueOnce(new Error("temporary IndexedDB read failure"));

    await configureTabRecoveryHistory(ACCOUNT_ONE);

    expect(useTabRecoveryHistory.getState().ready).toBe(true);
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);
    expect(useTabRecoveryHistory.getState().entries[0]).toMatchObject({
      kind: "header",
      items: [recovered],
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not publish a queued retry after switching accounts", async () => {
    const oldEntry = draft("old-account-entry");
    const store = createStore(persistKey("tab-recovery"), "history");
    await set(
      tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE),
      {
        version: 2,
        entries: [
          { kind: "header", id: "old", bulk: false, items: [oldEntry] },
        ],
      },
      store,
    );

    await resetTabRecoveryHistory();
    setWindow(WINDOW_ONE);
    const get = vi.mocked(idbKeyval.get);
    get.mockClear();
    get.mockRejectedValueOnce(new Error("temporary IndexedDB read failure"));
    const oldAccountHydration = configureTabRecoveryHistory(ACCOUNT_ONE);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());

    await configureTabRecoveryHistory(ACCOUNT_TWO);
    const newEntry = draft("new-account-entry");
    recordClosedHeaderTab(newEntry);
    await oldAccountHydration;

    expect(useTabRecoveryHistory.getState().ready).toBe(true);
    expect(useTabRecoveryHistory.getState().entries).toEqual([
      expect.objectContaining({
        kind: "header",
        items: [newEntry],
      }),
    ]);
  });

  it("retains pending closes and prunes for an unread account across an account switch", async () => {
    const deleted = draft("persisted-before-failure");
    recordClosedHeaderTab(deleted);
    await flushTabRecoveryHistory();

    const store = createStore(persistKey("tab-recovery"), "history");
    const key = tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE);
    const diskBeforeFailure = await idbGet<unknown>(key, store);
    expect(diskBeforeFailure).toEqual(expect.objectContaining({ version: 2 }));

    await resetTabRecoveryHistory();
    setWindow(WINDOW_ONE);
    const get = vi.mocked(idbKeyval.get);
    get.mockClear();
    get
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"))
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"))
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"));
    await configureTabRecoveryHistory(ACCOUNT_ONE);
    expect(useTabRecoveryHistory.getState().ready).toBe(false);

    const fresh = draft("pending-during-failure");
    recordClosedHeaderTab(fresh);
    pruneRecoveryDraft(deleted.draftId);
    expect(await idbGet<unknown>(key, store)).toEqual(diskBeforeFailure);

    await configureTabRecoveryHistory(ACCOUNT_TWO);
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);

    await configureTabRecoveryHistory(ACCOUNT_ONE);
    await flushTabRecoveryHistory();

    const recoveredItems = useTabRecoveryHistory
      .getState()
      .entries.flatMap((entry) => (entry.kind === "header" ? entry.items : []));
    expect(recoveredItems).toEqual([fresh]);
    const diskAfterRecovery = await idbGet<unknown>(key, store);
    if (
      typeof diskAfterRecovery !== "object" ||
      diskAfterRecovery === null ||
      !("entries" in diskAfterRecovery) ||
      !Array.isArray(diskAfterRecovery.entries)
    ) {
      throw new Error("expected the recovered journal to contain entries");
    }
    expect(diskAfterRecovery.entries).toHaveLength(1);
    expect(diskAfterRecovery.entries[0]).toMatchObject({
      kind: "header",
      items: [fresh],
    });
  });

  it("batches header closes into one bulk entry and suppresses internal closes", () => {
    const one = draft("draft-one");
    const two = draft("draft-two");
    const three = draft("draft-three");
    const oneRef: TabRef = { kind: "draft", id: one.draftId };
    const twoRef: TabRef = { kind: "draft", id: two.draftId };
    const threeRef: TabRef = { kind: "draft", id: three.draftId };

    recordClosedHeaderTab(one);
    withoutTabRecovery(() => recordClosedHeaderTab(two));
    batchHeaderTabRecovery(
      () => {
        recordClosedHeaderTab(two);
        withoutTabRecovery(() => recordClosedHeaderTab(three));
      },
      layoutForRefs([oneRef, twoRef, threeRef]),
    );

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "header", bulk: false });
    expect(entries[1]).toMatchObject({
      kind: "header",
      bulk: true,
      items: [{ ...two, index: 1 }],
    });
  });

  it("prunes deleted epics from mixed header entries and canvas entries", () => {
    const draftItem = draft("draft-survivor");
    const deletedTab = epicTab("epic-deleted", "tab-epic-deleted");
    const deletedRef: TabRef = { kind: "epic", id: deletedTab.tabId };
    const draftRef: TabRef = { kind: "draft", id: draftItem.draftId };
    batchHeaderTabRecovery(
      () => {
        recordClosedHeaderTab({
          kind: "epic",
          tab: deletedTab,
          canvas: canvasWithTwoTiles(),
          index: 0,
        });
        recordClosedHeaderTab(draftItem);
      },
      layoutForRefs([deletedRef, draftRef]),
    );
    const before = canvasWithTwoTiles();
    const afterA = closeTab(before, "p1", SPEC_A.instanceId);
    const after = closeTab(afterA, "p1", SPEC_B.instanceId);
    recordClosedCanvas(deletedTab, before, after, false);

    const beforePrune = useTabRecoveryHistory.getState().entries.at(0);
    if (beforePrune === undefined || beforePrune.kind !== "header") {
      throw new Error("expected the mixed header entry before pruning");
    }
    const survivorItem = beforePrune.items.find(
      (item) => item.kind === "draft",
    );
    if (survivorItem === undefined) {
      throw new Error("expected a surviving draft item");
    }

    pruneRecoveryEpics(["epic-deleted"]);

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "header",
      items: [{ ...draftItem, index: 1 }],
    });
    const afterPrune = entries[0];
    if (afterPrune.kind !== "header") {
      throw new Error("expected the mixed header entry after pruning");
    }
    expect(afterPrune.items[0]).toBe(survivorItem);
  });

  it("prunes deleted tile members and removes an empty canvas entry", () => {
    const before = canvasWithTwoTiles();
    const afterA = closeTab(before, "p1", SPEC_A.instanceId);
    const after = closeTab(afterA, "p1", SPEC_B.instanceId);
    recordClosedCanvas(
      epicTab("epic-tiles", "tab-epic-tiles"),
      before,
      after,
      false,
    );

    pruneRecoveryTiles((tile) => tile.id === SPEC_A.id);
    let entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "canvas",
      instanceIds: [SPEC_B.instanceId],
    });

    pruneRecoveryTiles((tile) => tile.id === SPEC_B.id);
    entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(0);
  });

  it("records saved drafts as references without an editor snapshot", () => {
    const item = draft("saved-draft");
    recordClosedHeaderTab(item);

    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined || entry.kind !== "header") {
      throw new Error("expected a draft recovery entry");
    }
    expect(entry.items).toEqual([item]);
    expect(entry.items[0]).not.toHaveProperty("draft");
    expect(entry.items[0]).not.toHaveProperty("content");
  });

  it("filters blank inner tiles without dropping a real closed tile", () => {
    const { canvas: before } = canvasWithBlankAndSpec();
    recordClosedCanvas(
      epicTab("epic-blank-inner", "tab-blank-inner"),
      before,
      emptyCanvas(),
      false,
    );

    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined || entry.kind !== "canvas") {
      throw new Error("expected a canvas recovery entry");
    }
    expect(entry.instanceIds).toEqual([SPEC_A.instanceId]);
  });

  it("retains an empty task recovery entry in the v2 journal", async () => {
    const task: TabRecoveryEntry = {
      kind: "header",
      id: "empty-task-header",
      bulk: false,
      items: [
        {
          kind: "epic",
          tab: epicTab("empty-task", "empty-task-tab"),
          canvas: emptyCanvas(),
          index: 0,
        },
      ],
    };

    await seedPersistedEntries([task]);

    expect(useTabRecoveryHistory.getState().entries).toEqual([task]);
  });

  it("ignores version 1 snapshot journals", async () => {
    await configureTabRecoveryHistory(null);
    await flushTabRecoveryHistory();
    const store = createStore(persistKey("tab-recovery"), "history");
    await set(
      tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE),
      {
        version: 1,
        entries: [
          {
            kind: "header",
            id: "old-snapshot",
            bulk: false,
            items: [
              {
                kind: "draft",
                draftId: "old-snapshot-draft",
                hostId: null,
                index: 0,
              },
            ],
          },
        ],
      },
      store,
    );
    setWindow(WINDOW_ONE);

    await configureTabRecoveryHistory(ACCOUNT_ONE);

    expect(useTabRecoveryHistory.getState().ready).toBe(true);
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
  });

  it("caps recovery actions at the newest 50 entries", () => {
    for (let index = 0; index < MAX_RECOVERY_ACTIONS + 5; index += 1)
      recordClosedHeaderTab(draft(`meaningful-${String(index)}`));

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(MAX_RECOVERY_ACTIONS);
    const ids = entries.map((entry) => {
      if (entry.kind !== "header") return "canvas";
      const item = entry.items.at(0);
      if (item === undefined || item.kind !== "draft") return "task";
      return item.draftId;
    });
    expect(ids).toEqual(
      Array.from(
        { length: MAX_RECOVERY_ACTIONS },
        (_, index) => `meaningful-${String(index + 5)}`,
      ),
    );
  });

  it("persists separately by account and desktop window", async () => {
    recordClosedHeaderTab(draft("window-one-draft"));

    setWindow(WINDOW_TWO);
    await configureTabRecoveryHistory(ACCOUNT_ONE);
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
    recordClosedHeaderTab(draft("window-two-draft"));

    setWindow(WINDOW_ONE);
    await configureTabRecoveryHistory(ACCOUNT_ONE);
    expect(
      useTabRecoveryHistory
        .getState()
        .entries.flatMap((entry) =>
          entry.kind === "header" ? entry.items : [],
        ),
    ).toHaveLength(1);

    await configureTabRecoveryHistory(ACCOUNT_TWO);
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
  });

  it("prunes a permanently deleted draft from recovery references", () => {
    recordClosedHeaderTab(draft("draft-to-delete"));
    recordClosedHeaderTab(draft("draft-to-keep"));

    pruneRecoveryDraft("draft-to-delete");

    const items = useTabRecoveryHistory
      .getState()
      .entries.flatMap((entry) => (entry.kind === "header" ? entry.items : []));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "draft", draftId: "draft-to-keep" });
  });
});
