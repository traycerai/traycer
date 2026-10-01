import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import {
  batchHeaderTabRecovery,
  useTabRecoveryHistory,
  type ClosedHeaderTab,
} from "@/lib/tab-recovery/history";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  landingDraftIsRetired,
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import {
  flattenLayoutRefs,
  tabItemId,
  tabRefKey,
  type SplitStripItem,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { tabSourceRefs } from "@/stores/tabs/source-refs";
import {
  peekStripEntrance,
  resetStripMotionForTesting,
  stripGroupMarkKey,
  subscribeClosingTabs,
  takeReopenGlow,
} from "@/stores/tabs/strip-motion";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { readTabStripLayout, useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    activationHistory: [],
    systemTabs: { history: null, settings: null },
    customizations: undefined,
    groups: undefined,
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore.getState().setRegionValues("homeTab", { shown: "hidden" });
  resetLandingDraftRetirementsForTests();
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
    activationHistory: [],
  };
  useTabsStore.setState({
    ...layout,
    stripOrder: refs,
  });
}

function seedLayout(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({
    ...layout,
    stripOrder: flattenLayoutRefs(layout),
  });
}

function tabItem(ref: TabRef) {
  return { kind: "tab" as const, id: tabItemId(ref), ref };
}

function splitItem(
  id: string,
  left: TabRef | null,
  right: TabRef | null,
  leftRatio: number,
): SplitStripItem {
  return {
    kind: "split",
    id,
    left: left === null ? { kind: "empty" } : { kind: "tab", ref: left },
    right: right === null ? { kind: "empty" } : { kind: "tab", ref: right },
    focusedSide: "right",
    routeBackingSide: left === null ? "right" : "left",
    leftRatio,
  };
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
  it("preserves Home selection and history when a background draft source appears", () => {
    useLayoutStore.getState().setRegionValues("homeTab", { shown: "shown" });
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-home-background", "Home background");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);
    useTabsStore.setState({ activeItemId: null, activationHistory: [taskRef] });

    const draftId = useLandingDraftStore.getState().createDraft(null);
    const draftRef: TabRef = { kind: "draft", id: draftId };
    tabCommandCoordinator.reconcileFromSourceStores();

    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(taskRef),
      tabRefKey(draftRef),
    ]);
    expect(useTabsStore.getState().activeItemId).toBeNull();
    expect(useTabsStore.getState().activationHistory).toEqual([taskRef]);
  });

  it("does not restore a retired closed draft while Home is selected", () => {
    useLayoutStore.getState().setRegionValues("homeTab", { shown: "shown" });
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-retired-closed", "Retained task");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);
    useTabsStore.setState({ activeItemId: null, activationHistory: [taskRef] });

    const draftId = "retired-closed-recovery";
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore.getState().setDraftContent(
      draftId,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "retained work" }],
          },
        ],
      },
      null,
    );
    useLandingDraftStore.getState().closeDraft(draftId);
    const recoveryItem: Extract<ClosedHeaderTab, { kind: "draft" }> = {
      kind: "draft",
      draftId,
      hostId: null,
      index: 1,
    };
    const layoutBefore = readTabStripLayout();
    const historyBefore = useTabsStore.getState().activationHistory;
    const rowBefore = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === draftId);
    expect(rowBefore?.closed).toBe(true);

    // Retire before the other window's storage event removes this retained row.
    retireLandingDraft(draftId, null);
    tabCommandCoordinator.restoreClosedHeaderTabs([recoveryItem], null);

    expect(readTabStripLayout()).toEqual(layoutBefore);
    expect(useTabsStore.getState().activationHistory).toEqual(historyBefore);
    expect(useLandingDraftStore.getState().drafts).toEqual([rowBefore]);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("rejects activation of a retired direct draft id without changing selection", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-retired-direct", "Retired direct");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);
    const before = readTabStripLayout();
    const retiredId = "retired-direct-id";
    retireLandingDraft(retiredId, null);

    expect(
      tabCommandCoordinator.activateTab({
        kind: "draft",
        draftId: retiredId,
        settings: null,
        create: true,
      }),
    ).toBeNull();
    expect(readTabStripLayout()).toEqual(before);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("rejects a retired ref target while its stale row remains before storage cleanup", () => {
    const id = "retired-ref-target";
    useLandingDraftStore.getState().createDraftWithId(id, null);
    const ref: TabRef = { kind: "draft", id };
    seedStrip([ref], ref);
    useLandingDraftStore.getState().clearActiveDraft();
    const before = readTabStripLayout();
    retireLandingDraft(id, null);

    expect(landingDraftIsRetired(id)).toBe(true);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(tabSourceRefs()).not.toContainEqual(ref);
    expect(tabCommandCoordinator.activateTab({ kind: "ref", ref })).toBeNull();
    expect(readTabStripLayout()).toEqual(before);
    useLandingDraftStore.getState().openDraft(id);
    useLandingDraftStore.getState().setActiveDraft(id);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("keeps the focused task active when a background landing draft source appears", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-background-draft", "Background draft");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);
    useTabsStore.setState({ activationHistory: [taskRef] });

    const draftId = useLandingDraftStore.getState().createDraft(null);
    const draftRef: TabRef = { kind: "draft", id: draftId };
    tabCommandCoordinator.reconcileFromSourceStores();

    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(taskRef),
      tabRefKey(draftRef),
    ]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(taskRef));
    expect(useTabsStore.getState().activationHistory).toEqual([taskRef]);
  });

  it("explicitly activates a newly created landing draft", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-explicit-draft", "Explicit draft");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);

    const activation = tabCommandCoordinator.activateTab({
      kind: "draft",
      draftId: null,
      settings: null,
      create: true,
    });
    expect(activation).not.toBeNull();
    if (activation === null || activation.ref.kind !== "draft") {
      throw new Error("expected explicit draft activation");
    }

    expect(useTabsStore.getState().activeItemId).toBe(
      tabItemId(activation.ref),
    );
    expect(useLandingDraftStore.getState().activeDraftId).toBe(
      activation.ref.id,
    );
    expect(stripRefs()).toContainEqual(activation.ref);
  });

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
    if (entry === undefined) {
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

  it("uses the strip item index for a direct close of an epic inside a split", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-split-index", "Split index");
    const draftRef: TabRef = { kind: "draft", id: draftId };
    const taskRef: TabRef = { kind: "epic", id: taskId };
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(draftRef), ref: draftRef },
        {
          kind: "split",
          id: "split-index",
          left: { kind: "tab", ref: taskRef },
          right: { kind: "empty" },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: tabItemId(draftRef),
      stripOrder: [draftRef, taskRef],
      activationHistory: [draftRef, taskRef],
      systemTabs: { history: null, settings: null },
    });

    useEpicCanvasStore.getState().closeTab(taskId);

    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
      throw new Error("expected the direct canvas close recovery entry");
    }
    expect(recovery.items).toHaveLength(1);
    expect(recovery.items[0]).toMatchObject({
      kind: "epic",
      tab: { tabId: taskId },
      index: 1,
    });
    expect(stripRefs()).toEqual([draftRef]);

    tabCommandCoordinator.restoreClosedHeaderTabs(recovery.items, null);

    expect(stripRefs()).toEqual([draftRef, taskRef]);
  });

  it("captures an empty canvas when a confirmed task close has no canvas entry", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-missing-canvas", "Missing canvas");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    useEpicCanvasStore.setState((state) => {
      const canvasByTabId = { ...state.canvasByTabId };
      delete canvasByTabId[taskId];
      return { canvasByTabId };
    });
    seedStrip([taskRef], taskRef);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(taskRef)).toBe(true);

    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
      throw new Error("expected the closed task recovery entry");
    }
    expect(recovery.items).toHaveLength(1);
    expect(recovery.items[0]).toMatchObject({
      kind: "epic",
      tab: { tabId: taskId, epicId: "epic-missing-canvas" },
      canvas: {
        root: null,
        activePaneId: null,
        tilesByInstanceId: {},
        sizesByGroupId: {},
      },
    });
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
    }, readTabStripLayout());

    const entries = useTabRecoveryHistory.getState().entries;
    expect(entries).toHaveLength(1);
    const entry = entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a bulk header recovery entry");
    }
    expect(entry.bulk).toBe(true);
    expect(entry.items.map((item) => item.kind)).toEqual(["epic", "draft"]);
    const recoveredDraft = entry.items.find((item) => item.kind === "draft");
    expect(recoveredDraft).toMatchObject({
      kind: "draft",
      draftId,
      hostId: null,
    });
    expect(recoveredDraft).not.toHaveProperty("draft");
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
    const restoredDraft = useLandingDraftStore
      .getState()
      .drafts.find((item) => item.id === draftId);
    if (restoredDraft === undefined) {
      throw new Error("expected the restored draft to remain in the store");
    }
    expect(restoredDraft.id).toBe(draftId);
    expect(restoredDraft.closed).toBe(false);
    expect(restoredDraft.content.type).toBe("doc");
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

  it("prunes a saved draft recovery reference on permanent deletion", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      draftId,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "delete" }] },
        ],
      },
      null,
    );
    const draftRef: TabRef = { kind: "draft", id: draftId };
    seedStrip([draftRef], draftRef);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(draftRef)).toBe(true);
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);

    useLandingDraftStore.getState().deleteDraft(draftId);

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
  });

  it("replaces an empty start draft while restoring the last closed task", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-empty-start", "Recovered task");
    const taskRef: TabRef = { kind: "epic", id: taskId };
    seedStrip([taskRef], taskRef);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(taskRef)).toBe(true);
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
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

  it("restores saved draft references with their latest text and image content", () => {
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
    const latestTextContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "latest" }] },
      ],
    };
    useLandingDraftStore
      .getState()
      .setDraftContent(textDraftId, latestTextContent, null);
    const taskRef: TabRef = { kind: "epic", id: taskId };
    const textRef: TabRef = { kind: "draft", id: textDraftId };
    const imageRef: TabRef = { kind: "draft", id: imageDraftId };
    seedStrip([taskRef, textRef, imageRef], taskRef);

    batchHeaderTabRecovery(() => {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(textRef)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(imageRef)).toBe(true);
    }, readTabStripLayout());
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
      throw new Error("expected the closed draft recovery entry");
    }
    expect(recovery.items).toEqual([
      { kind: "draft", draftId: textDraftId, hostId: null, index: 1 },
      { kind: "draft", draftId: imageDraftId, hostId: null, index: 2 },
    ]);

    seedStrip([taskRef], taskRef);
    tabCommandCoordinator.restoreClosedHeaderTabs(recovery.items, null);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(2);
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual([textDraftId, imageDraftId]);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === textDraftId)?.content,
    ).toEqual(latestTextContent);
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
    }, readTabStripLayout());
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
      throw new Error("expected the bulk task recovery entry");
    }
    const focusedBeforeRestore = useTabsStore.getState().activeItemId;
    useTabsStore.setState({ activationHistory: [survivorRef] });

    tabCommandCoordinator.restoreClosedHeaderTabs(recovery.items, null);

    expect(useTabsStore.getState().activeItemId).toBe(focusedBeforeRestore);
    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(refA),
      tabRefKey(refB),
      tabRefKey(survivorRef),
    ]);
    expect(useTabsStore.getState().activationHistory).toEqual([
      refB,
      refA,
      survivorRef,
    ]);
  });

  it.each(["left", "right"] as const)(
    "restores a closed %s split side with its original ratio and order",
    (closedSide) => {
      const taskA = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-place-a", "A");
      const taskB = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-place-b", "B");
      const taskC = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-place-c", "C");
      const refA: TabRef = { kind: "epic", id: taskA };
      const refB: TabRef = { kind: "epic", id: taskB };
      const refC: TabRef = { kind: "epic", id: taskC };
      const split = splitItem(`split-place-${closedSide}`, refA, refB, 0.37);
      seedLayout({
        version: 2,
        items: [tabItem(refC), split],
        activeItemId: split.id,
        systemTabs: { history: null, settings: null },
        activationHistory: [refB, refC],
      });

      const closed = closedSide === "left" ? refA : refB;
      expect(tabCommandCoordinator.closeRefAfterConfirmed(closed)).toBe(true);
      const entry = useTabRecoveryHistory.getState().entries.at(0);
      if (entry === undefined) {
        throw new Error("expected a split recovery entry");
      }
      expect(entry.items[0]).toMatchObject({
        index: 1,
        placement: { split },
      });

      tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

      const survivorSide = closedSide === "left" ? "right" : "left";
      expect(useTabsStore.getState().items).toEqual([
        tabItem(refC),
        { ...split, focusedSide: survivorSide, routeBackingSide: survivorSide },
      ]);
      const restored = useTabsStore.getState().items.at(1);
      if (restored === undefined || restored.kind !== "split")
        throw new Error("expected restored split");
      expect(restored.leftRatio).toBe(0.37);
      // Rejoining must keep the surviving tab's current focus side, even when
      // that side differs from the captured split's focused side.
      expect(restored.focusedSide).toBe(
        closedSide === "left" ? "right" : "left",
      );
    },
  );

  it("restores group metadata and per-tab appearance after a bulk group close", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-group-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-group-b", "B");
    const taskC = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-group-c", "C");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const refC: TabRef = { kind: "epic", id: taskC };
    const group = {
      name: "Review tabs",
      color: "#8ab4f8",
      collapsed: true,
    };
    seedLayout({
      version: 2,
      items: [tabItem(refA), tabItem(refB), tabItem(refC)],
      activeItemId: tabItemId(refC),
      systemTabs: { history: null, settings: null },
      customizations: {
        [tabRefKey(refA)]: {
          color: "#f28b82",
          icon: "A",
          groupId: "group-recover",
        },
        [tabRefKey(refB)]: {
          color: "#81c995",
          icon: "B",
          groupId: "group-recover",
        },
      },
      groups: { "group-recover": group },
      activationHistory: [refC],
    });

    batchHeaderTabRecovery(() => {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refB)).toBe(true);
    }, readTabStripLayout());
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a bulk group recovery entry");
    }
    expect(entry.items.map((item) => item.index)).toEqual([0, 1]);
    expect(entry.items[0]).toMatchObject({
      placement: {
        customization: {
          color: "#f28b82",
          icon: "A",
          groupId: "group-recover",
        },
        group,
      },
    });

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().groups).toEqual({ "group-recover": group });
    expect(useTabsStore.getState().customizations).toMatchObject({
      [tabRefKey(refA)]: {
        color: "#f28b82",
        icon: "A",
        groupId: "group-recover",
      },
      [tabRefKey(refB)]: {
        color: "#81c995",
        icon: "B",
        groupId: "group-recover",
      },
    });
    expect(stripRefs().map(tabRefKey)).toEqual([
      tabRefKey(refA),
      tabRefKey(refB),
      tabRefKey(refC),
    ]);
  });

  it("uses the renamed current group while recovering an older group member", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-renamed-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-renamed-b", "B");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const oldGroup = { name: "Before", color: "#fdd663", collapsed: false };
    seedLayout({
      version: 2,
      items: [tabItem(refA), tabItem(refB)],
      activeItemId: tabItemId(refB),
      systemTabs: { history: null, settings: null },
      customizations: {
        [tabRefKey(refA)]: { color: null, icon: "A", groupId: "renamed-group" },
        [tabRefKey(refB)]: { color: null, icon: "B", groupId: "renamed-group" },
      },
      groups: { "renamed-group": oldGroup },
    });

    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
    useTabsStore.getState().updateGroup("renamed-group", {
      name: "After",
      color: "#c58af9",
      collapsed: false,
    });
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a renamed-group recovery entry");
    }

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().groups?.["renamed-group"]).toEqual({
      name: "After",
      color: "#c58af9",
      collapsed: false,
    });
    expect(useTabsStore.getState().customizations).toMatchObject({
      [tabRefKey(refA)]: { groupId: "renamed-group" },
      [tabRefKey(refB)]: { groupId: "renamed-group" },
    });
  });

  it("keeps original top-level indices for a mixed split and standalone batch", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-mixed-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-mixed-b", "B");
    const taskC = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-mixed-c", "C");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const refC: TabRef = { kind: "epic", id: taskC };
    const split = splitItem("split-mixed", refA, refB, 0.42);
    seedLayout({
      version: 2,
      items: [split, tabItem(refC)],
      activeItemId: tabItemId(refC),
      systemTabs: { history: null, settings: null },
    });

    batchHeaderTabRecovery(() => {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refC)).toBe(true);
    }, readTabStripLayout());
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a mixed recovery entry");
    }
    expect(entry.items.map((item) => item.index)).toEqual([0, 1]);

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().items).toEqual([
      { ...split, routeBackingSide: "right" },
      tabItem(refC),
    ]);
  });

  it("restores a split once when both split members and a neighbor close in one batch", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-batch-split-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-batch-split-b", "B");
    const taskC = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-batch-split-c", "C");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const refC: TabRef = { kind: "epic", id: taskC };
    const split = splitItem("split-batch-both", refA, refB, 0.46);
    seedLayout({
      version: 2,
      items: [split, tabItem(refC)],
      activeItemId: tabItemId(refC),
      systemTabs: { history: null, settings: null },
    });

    batchHeaderTabRecovery(() => {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refB)).toBe(true);
      expect(tabCommandCoordinator.closeRefAfterConfirmed(refC)).toBe(true);
    }, readTabStripLayout());
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a full split batch recovery entry");
    }
    expect(entry.items.map((item) => item.index)).toEqual([0, 0, 1]);
    expect(
      entry.items
        .slice(0, 2)
        .every((item) => item.placement?.split?.id === split.id),
    ).toBe(true);

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().items).toEqual([split, tabItem(refC)]);
  });

  it("keeps a recovered tab standalone when its former survivor joins a new split", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-new-split-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-new-split-b", "B");
    const taskC = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-new-split-c", "C");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const refC: TabRef = { kind: "epic", id: taskC };
    seedLayout({
      version: 2,
      items: [tabItem(refC), splitItem("split-old", refA, refB, 0.6)],
      activeItemId: "split-old",
      systemTabs: { history: null, settings: null },
    });

    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
    const newSplit = splitItem("split-new", refB, refC, 0.8);
    seedLayout({
      version: 2,
      items: [newSplit],
      activeItemId: newSplit.id,
      systemTabs: { history: null, settings: null },
    });
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a split recovery entry");
    }

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().items).toEqual([newSplit, tabItem(refA)]);
    expect(useTabsStore.getState().items[0]).toEqual(newSplit);
  });

  it("keeps the recovered tab standalone when its former survivor changes group", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-new-group-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-new-group-b", "B");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const split = splitItem("split-new-group", refA, refB, 0.5);
    seedLayout({
      version: 2,
      items: [split],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
      customizations: {
        [tabRefKey(refA)]: {
          color: "#f28b82",
          icon: "A",
          groupId: "old-group",
        },
        [tabRefKey(refB)]: {
          color: "#81c995",
          icon: "B",
          groupId: "old-group",
        },
      },
      groups: {
        "old-group": { name: "Old", color: "#8ab4f8", collapsed: false },
      },
    });

    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
    const newGroupId = useTabsStore.getState().createGroup(refB);
    if (newGroupId === null) throw new Error("expected a new group");
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected a changed-group recovery entry");
    }

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().items).toEqual([
      tabItem(refA),
      tabItem(refB),
    ]);
    expect(useTabsStore.getState().customizations).toMatchObject({
      [tabRefKey(refA)]: { groupId: "old-group" },
      [tabRefKey(refB)]: { groupId: newGroupId },
    });
    expect(useTabsStore.getState().groups?.["old-group"]).toEqual({
      name: "Old",
      color: "#8ab4f8",
      collapsed: false,
    });
  });

  it("restores an empty opposite split side", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-empty-opposite", "Empty opposite");
    const ref: TabRef = { kind: "epic", id: taskId };
    const split = splitItem("split-empty-opposite", ref, null, 0.64);
    seedLayout({
      version: 2,
      items: [split],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
    });

    expect(tabCommandCoordinator.closeRefAfterConfirmed(ref)).toBe(true);
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected an empty-split recovery entry");
    }

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().items).toEqual([split]);
    expect(useTabsStore.getState().items[0]).toEqual(split);
  });

  it("keeps an intentional empty draft split peer during task recovery", () => {
    const taskId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-empty-draft-peer", "Task");
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const taskRef: TabRef = { kind: "epic", id: taskId };
    const draftRef: TabRef = { kind: "draft", id: draftId };
    const split = splitItem("split-empty-draft-peer", taskRef, draftRef, 0.55);
    seedLayout({
      version: 2,
      items: [split],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
    });

    expect(tabCommandCoordinator.closeRefAfterConfirmed(taskRef)).toBe(true);
    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected an empty-draft-peer recovery entry");
    }

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, draftId);

    expect(useLandingDraftStore.getState().drafts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: draftId })]),
    );
    expect(useTabsStore.getState().items).toEqual([
      { ...split, focusedSide: "right", routeBackingSide: "right" },
    ]);
  });

  it("captures and restores placement for a direct canvas-store close", () => {
    const taskA = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-direct-a", "A");
    const taskB = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-direct-b", "B");
    const refA: TabRef = { kind: "epic", id: taskA };
    const refB: TabRef = { kind: "epic", id: taskB };
    const split = splitItem("split-direct", refA, refB, 0.29);
    seedLayout({
      version: 2,
      items: [split],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
    });

    useEpicCanvasStore.getState().closeTab(taskA);

    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined) {
      throw new Error("expected direct-close recovery entry");
    }
    expect(entry.items[0]).toMatchObject({
      index: 0,
      placement: { split },
    });

    tabCommandCoordinator.restoreClosedHeaderTabs(entry.items, null);

    expect(useTabsStore.getState().items).toEqual([
      { ...split, focusedSide: "right", routeBackingSide: "right" },
    ]);
  });
});

function stripMotionDelayFor(ref: TabRef): number | null {
  return peekStripEntrance([tabRefKey(ref)])?.delayMs ?? null;
}

function openTaskRef(epicId: string): TabRef {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, epicId);
  return { kind: "epic", id: tabId };
}

/** The items the recovery history journalled for the close just made. */
function latestRecoveryItems(): ReadonlyArray<ClosedHeaderTab> {
  const entry = useTabRecoveryHistory.getState().entries.at(0);
  if (entry === undefined) {
    throw new Error("expected a recovery entry");
  }
  return entry.items;
}

/** Closes `refs` in one gesture, as Close Other Tabs does. */
function closeTogether(
  refs: ReadonlyArray<TabRef>,
): ReadonlyArray<ClosedHeaderTab> {
  batchHeaderTabRecovery(() => {
    for (const ref of refs) {
      expect(tabCommandCoordinator.closeRefAfterConfirmed(ref)).toBe(true);
    }
  }, readTabStripLayout());
  return latestRecoveryItems();
}

/**
 * Whether each closing notice names `ref` while it is still in the strip: the
 * strip measures the tab it is about to lose, so it has to be there when told.
 */
function watchStripAtClosingNotices(ref: TabRef): boolean[] {
  const namedWhileInStrip: boolean[] = [];
  subscribeClosingTabs((closingKeys) => {
    namedWhileInStrip.push(
      closingKeys.includes(tabRefKey(ref)) &&
        stripRefs().some((stripRef) => tabRefKey(stripRef) === tabRefKey(ref)),
    );
  });
  return namedWhileInStrip;
}

describe("strip motion marks from the command coordinator", () => {
  beforeEach(() => {
    resetStripMotionForTesting();
  });

  it("marks a tab that activation opens", () => {
    const taskRef = openTaskRef("epic-motion-open");
    seedStrip([taskRef], taskRef);

    const activation = tabCommandCoordinator.activateTab({
      kind: "draft",
      draftId: null,
      settings: null,
      create: true,
    });
    if (activation === null) {
      throw new Error("expected the draft activation");
    }

    expect(stripMotionDelayFor(activation.ref)).toBe(0);
    expect(stripMotionDelayFor(taskRef)).toBeNull();
  });

  it("marks nothing when activation only selects a tab that is already open", () => {
    const refA = openTaskRef("epic-motion-select-a");
    const refB = openTaskRef("epic-motion-select-b");
    seedStrip([refA, refB], refA);

    expect(
      tabCommandCoordinator.activateTab({ kind: "ref", ref: refB }),
    ).not.toBeNull();

    expect(stripMotionDelayFor(refB)).toBeNull();
  });

  it("tells the strip about a close while the closing task is still in it", () => {
    const refA = openTaskRef("epic-motion-close-a");
    const refB = openTaskRef("epic-motion-close-b");
    seedStrip([refA, refB], refA);
    const refAStillInStrip = watchStripAtClosingNotices(refA);

    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);

    expect(refAStillInStrip).toEqual([true]);
    expect(stripRefs().map(tabRefKey)).toEqual([tabRefKey(refB)]);
  });

  it("does not tell the strip about a close that is refused", () => {
    const taskRef = openTaskRef("epic-motion-refused");
    seedStrip([taskRef], taskRef);
    const notices = watchStripAtClosingNotices(taskRef);

    expect(
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "epic",
        id: "not-in-the-strip",
      }),
    ).toBe(false);

    expect(notices).toEqual([]);
  });

  it("staggers reopened tasks in strip order, whatever order the journal lists them", () => {
    const refA = openTaskRef("epic-motion-bulk-a");
    const refB = openTaskRef("epic-motion-bulk-b");
    const survivorRef = openTaskRef("epic-motion-bulk-survivor");
    seedStrip([refA, refB, survivorRef], survivorRef);
    const closed = closeTogether([refA, refB]);

    tabCommandCoordinator.restoreClosedHeaderTabs(closed.toReversed(), null);

    expect(stripMotionDelayFor(refA)).toBe(0);
    expect(stripMotionDelayFor(refB)).toBe(30);
    expect(stripMotionDelayFor(survivorRef)).toBeNull();
  });

  it("gives a split side that rejoins a partner still open the join glow but no entrance", () => {
    const refA = openTaskRef("epic-motion-rejoin-a");
    const refB = openTaskRef("epic-motion-rejoin-b");
    const refC = openTaskRef("epic-motion-rejoin-c");
    const split = splitItem("split-motion-rejoin", refA, refB, 0.4);
    seedLayout({
      version: 2,
      items: [tabItem(refC), split],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
    });
    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
    const closed = latestRecoveryItems();
    expect(closed[0]).toMatchObject({ placement: { split } });

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, null);

    expect(useTabsStore.getState().items.at(1)?.kind).toBe("split");
    expect(stripMotionDelayFor(refA)).toBeNull();
    expect(stripMotionDelayFor(refB)).toBeNull();
    expect(takeReopenGlow([tabRefKey(refA)])).toBe(true);
  });

  it("does not count a rejoining split side in the stagger of the tabs reopened with it", () => {
    const refA = openTaskRef("epic-motion-mixed-a");
    const refB = openTaskRef("epic-motion-mixed-b");
    const refD = openTaskRef("epic-motion-mixed-d");
    const split = splitItem("split-motion-mixed", refA, refB, 0.4);
    seedLayout({
      version: 2,
      items: [split, tabItem(refD)],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
    });
    const closed = closeTogether([refA, refD]);
    expect(closed.map((item) => item.index)).toEqual([0, 1]);

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, null);

    expect(stripMotionDelayFor(refA)).toBeNull();
    expect(stripMotionDelayFor(refD)).toBe(0);
    expect(takeReopenGlow([tabRefKey(refA), tabRefKey(refD)])).toBe(false);
  });

  it("enters a split at once when both of its sides were closed", () => {
    const refA = openTaskRef("epic-motion-whole-a");
    const refB = openTaskRef("epic-motion-whole-b");
    const refC = openTaskRef("epic-motion-whole-c");
    const split = splitItem("split-motion-whole", refA, refB, 0.4);
    seedLayout({
      version: 2,
      items: [split, tabItem(refC)],
      activeItemId: tabItemId(refC),
      systemTabs: { history: null, settings: null },
    });
    const closed = closeTogether([refA, refB]);

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, null);

    expect(peekStripEntrance([tabRefKey(refA), tabRefKey(refB)])).toEqual({
      delayMs: 0,
    });
    expect(stripMotionDelayFor(refC)).toBeNull();
  });

  it("staggers a split restored whole as one strip item, so a standalone tab restored after it waits 30ms", () => {
    const refA = openTaskRef("epic-motion-item-a");
    const refB = openTaskRef("epic-motion-item-b");
    const refC = openTaskRef("epic-motion-item-c");
    const split = splitItem("split-motion-item", refA, refB, 0.4);
    seedLayout({
      version: 2,
      items: [split, tabItem(refC)],
      activeItemId: split.id,
      systemTabs: { history: null, settings: null },
    });
    const closed = closeTogether([refA, refB, refC]);

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, null);

    expect(useTabsStore.getState().items).toEqual([split, tabItem(refC)]);
    expect(peekStripEntrance([tabRefKey(refA), tabRefKey(refB)])).toEqual({
      delayMs: 0,
    });
    expect(stripMotionDelayFor(refC)).toBe(30);
  });

  it("glows a single reopened task, once", () => {
    const refA = openTaskRef("epic-motion-glow-a");
    const survivorRef = openTaskRef("epic-motion-glow-survivor");
    seedStrip([refA, survivorRef], survivorRef);
    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);

    tabCommandCoordinator.restoreClosedHeaderTabs(latestRecoveryItems(), null);

    expect(takeReopenGlow([tabRefKey(refA)])).toBe(true);
    expect(takeReopenGlow([tabRefKey(refA)])).toBe(false);
  });

  it("glows none of several tasks reopened together", () => {
    const refA = openTaskRef("epic-motion-pair-a");
    const refB = openTaskRef("epic-motion-pair-b");
    const survivorRef = openTaskRef("epic-motion-pair-survivor");
    seedStrip([refA, refB, survivorRef], survivorRef);
    const closed = closeTogether([refA, refB]);

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, null);

    expect(takeReopenGlow([tabRefKey(refA), tabRefKey(refB)])).toBe(false);
  });

  it("opens a recreated group's chip first and holds its tabs back", () => {
    const refA = openTaskRef("epic-motion-group-a");
    const refB = openTaskRef("epic-motion-group-b");
    const refC = openTaskRef("epic-motion-group-c");
    seedLayout({
      version: 2,
      items: [tabItem(refA), tabItem(refB), tabItem(refC)],
      activeItemId: tabItemId(refC),
      systemTabs: { history: null, settings: null },
      customizations: {
        [tabRefKey(refA)]: { color: null, icon: "A", groupId: "group-motion" },
        [tabRefKey(refB)]: { color: null, icon: "B", groupId: "group-motion" },
      },
      groups: {
        "group-motion": { name: "Motion", color: "#8ab4f8", collapsed: false },
      },
      activationHistory: [refC],
    });
    const closed = closeTogether([refA, refB]);
    expect(useTabsStore.getState().groups?.["group-motion"]).toBeUndefined();

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, null);

    expect(peekStripEntrance([stripGroupMarkKey("group-motion")])).toEqual({
      delayMs: 0,
    });
    expect(stripMotionDelayFor(refA)).toBe(60);
    expect(stripMotionDelayFor(refB)).toBe(90);
  });

  it("leaves a surviving group's chip alone and does not hold its returning tab back", () => {
    const refA = openTaskRef("epic-motion-kept-a");
    const refB = openTaskRef("epic-motion-kept-b");
    seedLayout({
      version: 2,
      items: [tabItem(refA), tabItem(refB)],
      activeItemId: tabItemId(refB),
      systemTabs: { history: null, settings: null },
      customizations: {
        [tabRefKey(refA)]: { color: null, icon: "A", groupId: "group-kept" },
        [tabRefKey(refB)]: { color: null, icon: "B", groupId: "group-kept" },
      },
      groups: {
        "group-kept": { name: "Kept", color: "#8ab4f8", collapsed: false },
      },
    });
    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);

    tabCommandCoordinator.restoreClosedHeaderTabs(latestRecoveryItems(), null);

    expect(peekStripEntrance([stripGroupMarkKey("group-kept")])).toBeNull();
    expect(stripMotionDelayFor(refA)).toBe(0);
  });

  it("tells the strip about a close when a reopen replaces the empty start page", () => {
    const taskRef = openTaskRef("epic-motion-replace");
    seedStrip([taskRef], taskRef);
    expect(tabCommandCoordinator.closeRefAfterConfirmed(taskRef)).toBe(true);
    const closed = latestRecoveryItems();
    const emptyStartId = useLandingDraftStore.getState().createDraft(null);
    const emptyStartRef: TabRef = { kind: "draft", id: emptyStartId };
    seedStrip([emptyStartRef], emptyStartRef);
    const emptyStartStillInStrip = watchStripAtClosingNotices(emptyStartRef);

    tabCommandCoordinator.restoreClosedHeaderTabs(closed, emptyStartId);

    expect(emptyStartStillInStrip).toEqual([true]);
    expect(stripRefs().map(tabRefKey)).toEqual([tabRefKey(taskRef)]);
  });

  it("does not tell the strip about a close when a reopen replaces nothing", () => {
    const refA = openTaskRef("epic-motion-plain-a");
    const refB = openTaskRef("epic-motion-plain-b");
    seedStrip([refA, refB], refB);
    expect(tabCommandCoordinator.closeRefAfterConfirmed(refA)).toBe(true);
    const notices = watchStripAtClosingNotices(refB);

    tabCommandCoordinator.restoreClosedHeaderTabs(latestRecoveryItems(), null);

    expect(notices).toEqual([]);
  });
});
