import { beforeEach, describe, expect, it } from "vitest";
import { createStore, set } from "idb-keyval";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
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
import {
  batchHeaderTabRecovery,
  configureTabRecoveryHistory,
  MAX_RECOVERY_ACTIONS,
  pruneRecoveryDraft,
  pruneRecoveryEpics,
  pruneRecoveryTiles,
  recordClosedCanvas,
  recordClosedHeaderTab,
  recoveryDrafts,
  removeRecoveryEntry,
  flushTabRecoveryHistory,
  resetTabRecoveryHistory,
  useTabRecoveryHistory,
  withoutTabRecovery,
  type ClosedHeaderTab,
  type LegacyRecoveryDraft,
  type TabRecoveryEntry,
} from "../history";

const WINDOW_ONE = "recovery-window-one";
const WINDOW_TWO = "recovery-window-two";
const ACCOUNT_ONE = "recovery-account-one";
const ACCOUNT_TWO = "recovery-account-two";

function setWindow(windowId: string): void {
  Reflect.set(globalThis, "runnerHost", { windows: { windowId } });
}

function draft(
  id: string,
  _content: JsonContent,
): Extract<ClosedHeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    draftId: id,
    hostId: null,
    index: 0,
  };
}

function legacyDraft(id: string, content: JsonContent): LegacyRecoveryDraft {
  return {
    id,
    content,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: {
      folders: [],
      primaryPath: null,
      folderInfoByPath: {},
    },
  };
}

function legacyDraftItem(
  id: string,
  content: JsonContent,
  index = 0,
): Record<string, unknown> {
  return { kind: "draft", draft: legacyDraft(id, content), index };
}

function legacyDraftRef(
  id: string,
  content: JsonContent,
): Extract<ClosedHeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    draftId: id,
    hostId: null,
    legacyDraft: legacyDraft(id, content),
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

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function imageContent(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: hash,
              fileName: "image.png",
              hash,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
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
  entries: readonly unknown[],
): Promise<void> {
  await configureTabRecoveryHistory(null);
  await flushTabRecoveryHistory();
  const store = createStore(persistKey("tab-recovery"), "history");
  await set(
    tabRecoveryKey(ACCOUNT_ONE, WINDOW_ONE),
    { version: 1, entries },
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

describe("tab recovery history", () => {
  it("batches header closes into one bulk entry and suppresses internal closes", () => {
    const one = draft("draft-one", textContent("one"));
    const two = draft("draft-two", textContent("two"));
    const three = draft("draft-three", textContent("three"));

    recordClosedHeaderTab(one);
    withoutTabRecovery(() => recordClosedHeaderTab(two));
    batchHeaderTabRecovery(() => {
      recordClosedHeaderTab(two);
      withoutTabRecovery(() => recordClosedHeaderTab(three));
    });

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "header", bulk: false });
    expect(entries[1]).toMatchObject({
      kind: "header",
      bulk: true,
      items: [two],
    });
  });

  it("prunes deleted epics from mixed header entries and canvas entries", () => {
    const draftItem = draft("draft-survivor", textContent("survivor"));
    batchHeaderTabRecovery(() => {
      recordClosedHeaderTab({
        kind: "epic",
        tab: epicTab("epic-deleted", "tab-epic-deleted"),
        canvas: canvasWithTwoTiles(),
        index: 0,
      });
      recordClosedHeaderTab(draftItem);
    });
    const before = canvasWithTwoTiles();
    const afterA = closeTab(before, "p1", SPEC_A.instanceId);
    const after = closeTab(afterA, "p1", SPEC_B.instanceId);
    recordClosedCanvas(
      epicTab("epic-deleted", "tab-epic-deleted"),
      before,
      after,
      false,
    );

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
    const item = draft(
      "saved-draft",
      textContent("latest content lives in the store"),
    );
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

  it("caps meaningful recovery actions while ignoring blank Start Pages", () => {
    for (let index = 0; index < MAX_RECOVERY_ACTIONS + 5; index += 1)
      recordClosedHeaderTab(
        draft(`meaningful-${String(index)}`, textContent(String(index))),
      );
    for (let index = 0; index < 5; index += 1)
      recordClosedHeaderTab(
        legacyDraftRef(`blank-${String(index)}`, {
          type: "doc",
          content: [{ type: "paragraph" }],
        }),
      );

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

  it("cleans blank legacy entries while retaining mixed content and empty tasks", async () => {
    const blank = legacyDraftItem("legacy-blank", {
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const whitespace = legacyDraftItem(
      "legacy-whitespace",
      textContent("  \n\t"),
      1,
    );
    const text = legacyDraftItem("legacy-text", textContent("persist me"), 2);
    const image = legacyDraftItem(
      "legacy-image",
      imageContent("legacy-image-hash"),
      3,
    );
    const task: ClosedHeaderTab = {
      kind: "epic",
      tab: epicTab("legacy-empty-task", "legacy-task-tab"),
      canvas: emptyCanvas(),
      index: 4,
    };
    const { canvas: canvasWithBlank, blankInstanceId } =
      canvasWithBlankAndSpec();
    const blankCanvasEntry: TabRecoveryEntry = {
      kind: "canvas",
      id: "legacy-blank-canvas",
      tab: epicTab("legacy-blank-canvas", "legacy-blank-canvas-tab"),
      before: canvasWithBlank,
      after: emptyCanvas(),
      instanceIds: [blankInstanceId],
      bulk: false,
    };
    const mixedCanvasEntry: TabRecoveryEntry = {
      kind: "canvas",
      id: "legacy-mixed-canvas",
      tab: epicTab("legacy-mixed-canvas", "legacy-mixed-canvas-tab"),
      before: canvasWithBlank,
      after: emptyCanvas(),
      instanceIds: [blankInstanceId, SPEC_A.instanceId],
      bulk: false,
    };
    await seedPersistedEntries([
      {
        kind: "header",
        id: "legacy-empty-header",
        bulk: false,
        items: [blank],
      },
      {
        kind: "header",
        id: "legacy-mixed-header",
        bulk: true,
        items: [blank, whitespace, text, image, task],
      },
      blankCanvasEntry,
      mixedCanvasEntry,
      {
        kind: "header",
        id: "legacy-empty-task-header",
        bulk: false,
        items: [task],
      },
    ]);

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual([
      "legacy-mixed-header",
      "legacy-mixed-canvas",
      "legacy-empty-task-header",
    ]);
    const mixedHeader = entries.at(0);
    if (mixedHeader === undefined || mixedHeader.kind !== "header") {
      throw new Error("expected the mixed header entry");
    }
    expect(
      mixedHeader.items.map((item) =>
        item.kind === "draft" ? item.draftId : item.tab.tabId,
      ),
    ).toEqual(["legacy-text", "legacy-image", "legacy-task-tab"]);
    expect(mixedHeader.items.map((item) => item.index)).toEqual([2, 3, 4]);
    const mixedCanvas = entries.at(1);
    if (mixedCanvas === undefined || mixedCanvas.kind !== "canvas") {
      throw new Error("expected the mixed canvas entry");
    }
    expect(mixedCanvas.instanceIds).toEqual([SPEC_A.instanceId]);
    const emptyTaskHeader = entries.at(2);
    if (emptyTaskHeader === undefined || emptyTaskHeader.kind !== "header") {
      throw new Error("expected the empty task header entry");
    }
    const emptyTask = emptyTaskHeader.items.at(0);
    expect(emptyTaskHeader.items).toHaveLength(1);
    expect(emptyTask).toMatchObject({
      kind: "epic",
      tab: { tabId: "legacy-task-tab" },
      canvas: emptyCanvas(),
    });
  });

  it("persists separately by account and desktop window", async () => {
    recordClosedHeaderTab(draft("window-one-draft", textContent("window one")));

    setWindow(WINDOW_TWO);
    await configureTabRecoveryHistory(ACCOUNT_ONE);
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
    recordClosedHeaderTab(draft("window-two-draft", textContent("window two")));

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

  it("does not treat a saved draft reference as an image ownership root", () => {
    const item = draft("draft-with-image", imageContent("image-hash"));
    recordClosedHeaderTab(item);

    expect(recoveryDrafts()).toEqual([]);
    expect(landingLiveImageRootHashes()).toEqual(new Set());

    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) throw new Error("expected recovery entry");
    removeRecoveryEntry(entry.id);
    expect(recoveryDrafts()).toEqual([]);
    expect(landingLiveImageRootHashes()).toEqual(new Set());
  });

  it("keeps image hashes for a legacy snapshot during migration", () => {
    const hash = "a".repeat(64);
    const item = legacyDraftRef("legacy-image-draft", imageContent(hash));
    recordClosedHeaderTab(item);

    expect(recoveryDrafts()).toEqual([item.legacyDraft]);
    expect(landingLiveImageRootHashes()).toEqual(new Set([hash]));
  });

  it("prunes a permanently deleted draft from recovery references", () => {
    recordClosedHeaderTab(draft("draft-to-delete", textContent("remove me")));
    recordClosedHeaderTab(draft("draft-to-keep", textContent("keep me")));

    pruneRecoveryDraft("draft-to-delete");

    const items = useTabRecoveryHistory
      .getState()
      .entries.flatMap((entry) => (entry.kind === "header" ? entry.items : []));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "draft", draftId: "draft-to-keep" });
  });
});
