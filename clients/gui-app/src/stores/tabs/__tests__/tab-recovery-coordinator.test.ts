import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import {
  batchHeaderTabRecovery,
  useTabRecoveryHistory,
} from "@/lib/tab-recovery/history";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { closeTab } from "@/stores/epics/canvas/actions";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import {
  CHAT_A,
  SPEC_A,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { registerChatTabViewportCapture } from "@/stores/chats/chat-tab-viewport-handoff";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  tabItemId,
  tabRefKey,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabRecoveryHistory.setState({ entries: [], ready: true });
  __resetTabSyncCoordinatorForTesting();
  tabCommandCoordinator.resetReconciliationForTesting();
}

function seedStrip(refs: ReadonlyArray<TabRef>, active: TabRef): void {
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: refs.map((ref) => ({
      kind: "tab",
      id: tabItemId(ref),
      ref,
    })),
    activeItemId: tabItemId(active),
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState({
    ...layout,
    stripOrder: refs,
  });
}

function stripRefs(): ReadonlyArray<TabRef> {
  const state = useTabsStore.getState();
  return flattenLayoutRefs({
    version: state.version,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
    activationHistory: state.activationHistory,
  });
}

beforeEach(async () => {
  resetStores();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
});

afterEach(() => {
  resetStores();
});

describe("tab recovery through the command coordinator", () => {
  it("journals a confirmed task close and restores strip visibility without stealing focus", () => {
    const taskA = useEpicCanvasStore.getState().openEpicTab("epic-a", "Task A");
    const taskB = useEpicCanvasStore.getState().openEpicTab("epic-b", "Task B");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    seedStrip([refA, refB], refA);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(1);
    const entry = entries.at(0);
    if (entry === undefined || entry.kind !== "header") {
      throw new Error("expected a header recovery entry");
    }
    expect(entry.bulk).toBe(false);
    expect(entry.items).toHaveLength(1);
    expect(entry.items[0]).toMatchObject({
      kind: "epic",
      tab: { tabId: taskA, epicId: "epic-a" },
      index: 0,
    });
    expect(stripRefs().map(tabRefKey)).toEqual([tabRefKey(refB)]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(refB));

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(refA),
      tabRefKey(refB),
    ]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(refB));
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(taskA);
  });

  it("groups a task and draft close, then restores both while preserving the surviving focus", () => {
    const taskA = useEpicCanvasStore.getState().openEpicTab("epic-a", "Task A");
    const taskB = useEpicCanvasStore.getState().openEpicTab("epic-b", "Task B");
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      draftId,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "recoverable draft" }],
          },
        ],
      },
      null,
    );
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const draftRef: TabRef = { kind: "draft", id: draftId };
    seedStrip([refA, refB, draftRef], refA);

    // This is the same boundary used by Close Other Tabs: each confirmed
    // source removal contributes one item to one bulk recovery action.
    batchHeaderTabRecovery(() => {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refB)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(draftRef)).toBe(true);
    });

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(1);
    const entry = entries.at(0);
    if (entry === undefined || entry.kind !== "header") {
      throw new Error("expected a bulk header recovery entry");
    }
    expect(entry.bulk).toBe(true);
    expect(entry.items.map((item) => item.kind)).toEqual(["epic", "draft"]);
    // The draft is at live index 1 after Task B is removed; batching maps it
    // back to its original strip position 2 so reopening preserves order.
    expect(entry.items.map((item) => item.index)).toEqual([1, 2]);
    expect(stripRefs().map(tabRefKey)).toEqual([tabRefKey(refA)]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(refA));

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(refA),
      tabRefKey(refB),
      tabRefKey(draftRef),
    ]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(refA));
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(taskB);
    expect(
      useLandingDraftStore.getState().drafts.map((item) => item.id),
    ).toContain(draftId);
  });

  it("does not journal a draft consumed by a successful draft-to-task replacement", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const draftRef: TabRef = { kind: "draft", id: draftId };
    seedStrip([draftRef], draftRef);

    const replacement = tabCommandCoordinator.replaceDraftWithEpic({
      draftId,
      epicId: "epic-submitted",
      epicTabId: "task-submitted",
      epicName: "Submitted task",
    });

    expect(replacement).toEqual({ kind: "epic", id: "task-submitted" });
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
    expect(stripRefs().map(tabRefKey)).toEqual(["epic:task-submitted"]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("captures a surviving chat viewport before restoring a closed split", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-viewport", "Viewport task");
    const before: EpicCanvasState = {
      root: {
        kind: "group" as const,
        id: "split-viewport",
        direction: "horizontal" as const,
        children: [
          pane("pane-chat", [CHAT_A.instanceId]),
          pane("pane-closed", [SPEC_A.instanceId]),
        ],
      },
      activePaneId: "pane-chat",
      tilesByInstanceId: {
        [CHAT_A.instanceId]: CHAT_A,
        [SPEC_A.instanceId]: SPEC_A,
      },
      sizesByGroupId: { "split-viewport": [0.5, 0.5] },
    };
    const after = closeTab(before, "pane-closed", SPEC_A.instanceId);
    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: { ...state.canvasByTabId, [tabId]: after },
    }));

    const capturedCanvases: (typeof after)[] = [];
    const unregister = registerChatTabViewportCapture(
      CHAT_A.instanceId,
      () => {
        const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
        if (canvas !== undefined) capturedCanvases.push(canvas);
      },
      {
        viewKey: CHAT_A.instanceId,
        contentKey: null,
        deletionKey: null,
        epicId: "epic-viewport",
        hostId: CHAT_A.hostId,
        durability: "renderer-live",
      },
    );
    onTestFinished(unregister);

    useEpicCanvasStore.getState().restoreCanvasForRecovery(tabId, {
      before,
      after,
      instanceIds: [SPEC_A.instanceId],
      focus: false,
    });

    expect(capturedCanvases).toEqual([after]);
    expect(useEpicCanvasStore.getState().canvasByTabId[tabId]).not.toBe(after);
  });

  it("replaces an empty start draft while restoring the last closed task", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-empty-start", "Recovered task");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(taskRef)).toBe(true);
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined || recovery.kind !== "header") {
      throw new Error("expected the closed task recovery entry");
    }

    const emptyStartId = useLandingDraftStore.getState().createDraft(null);
    const emptyStartRef: TabRef = { kind: "draft", id: emptyStartId };
    seedStrip([emptyStartRef], emptyStartRef);

    tabCommandCoordinator.restoreClosedHeaderTabs(recovery.items, emptyStartId);

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(taskId);
    expect(stripRefs().map(tabRefKey)).toEqual([tabRefKey(taskRef)]);
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);
    expect(useTabRecoveryHistory.getState().entries.at(0)).toMatchObject({
      kind: "header",
      items: [{ kind: "epic", tab: { tabId: taskId } }],
    });
  });

  it("preserves nonempty text and image drafts during task recovery", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-preserve-drafts", "Task with drafts");
    const textDraftId = useLandingDraftStore.getState().createDraft(null);
    const imageDraftId = useLandingDraftStore.getState().createDraft(null);
    const textContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "keep" }] },
      ],
    };
    const imageContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "image-to-keep",
                fileName: "keep.png",
                hash: "keep-image-hash",
                mimeType: "image/png",
                size: 3,
              },
            },
          ],
        },
      ],
    };
    useLandingDraftStore
      .getState()
      .setDraftContent(textDraftId, textContent, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(imageDraftId, imageContent, null);
    const taskRef: TabRef = { kind: "epic", id: taskId };
    const textRef: TabRef = { kind: "draft", id: textDraftId };
    const imageRef: TabRef = { kind: "draft", id: imageDraftId };
    seedStrip([taskRef, textRef, imageRef], taskRef);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(taskRef)).toBe(true);
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined || recovery.kind !== "header") {
      throw new Error("expected the closed task recovery entry");
    }

    seedStrip([textRef, imageRef], textRef);
    tabCommandCoordinator.restoreClosedHeaderTabs(recovery.items, null);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(2);
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual([textDraftId, imageDraftId]);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === textDraftId)?.content,
    ).toEqual(textContent);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === imageDraftId)?.content,
    ).toEqual(imageContent);
  });

  it("keeps the surviving bulk header selection while restoring closed tasks", () => {
    const taskA = useEpicCanvasStore.getState().openEpicTab("epic-bulk-a", "A");
    const taskB = useEpicCanvasStore.getState().openEpicTab("epic-bulk-b", "B");
    const survivor = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-bulk-survivor", "Survivor");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const survivorRef: TabRef = { kind: "epic", id: survivor };
    seedStrip([refA, refB, survivorRef], survivorRef);

    batchHeaderTabRecovery(() => {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refB)).toBe(true);
    });
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined || recovery.kind !== "header") {
      throw new Error("expected the bulk task recovery entry");
    }
    const focusedBeforeRestore = useTabsStore.getState().activeItemId;

    tabCommandCoordinator.restoreClosedHeaderTabs(recovery.items, null);

    expect(useTabsStore.getState().activeItemId).toBe(focusedBeforeRestore);
    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(refA),
      tabRefKey(refB),
      tabRefKey(survivorRef),
    ]);
  });
});
