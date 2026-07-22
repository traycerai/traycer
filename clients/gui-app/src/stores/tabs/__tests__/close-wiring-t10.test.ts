/**
 * T10 Area 1: every `TabKindModule.requestClose` used to mutate its own
 * source store directly (`useEpicCanvasStore.closeTab`,
 * `useLandingDraftStore.closeDraft`, `useTabsStore.closeSystemTab`),
 * bypassing the coordinator entirely. Layout removal then happened later,
 * asynchronously, through the coordinator's generic source-reconciliation
 * pass - not through the precise `removeLayoutRef` algebra that implements
 * survivor-promotion / active-preservation. These tests dispatch through the
 * REAL `tabRequestClose` registry function (exactly what
 * `use-close-tab-flow.tsx` calls) against real store state and assert on the
 * resulting `useTabsStore` layout, so a regression back to the direct-source
 * bypass shows up here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { tabRequestClose } from "@/stores/tabs/registry";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState, EpicViewTab } from "@/stores/epics/canvas/types";
import type { TabRef } from "@/stores/tabs/types";

const NOOP_CANVAS: EpicCanvasState = createEmptyCanvas();

function seedEpicTabs(
  tabs: ReadonlyArray<{ tabId: string; epicId: string; name: string }>,
  activeTabId: string,
): void {
  const tabsById: Record<string, EpicViewTab> = {};
  const canvasByTabId: Record<string, EpicCanvasState> = {};
  for (const tab of tabs) {
    tabsById[tab.tabId] = {
      tabId: tab.tabId,
      epicId: tab.epicId,
      name: tab.name,
    };
    canvasByTabId[tab.tabId] = NOOP_CANVAS;
  }
  useEpicCanvasStore.setState({
    tabsById,
    canvasByTabId,
    openTabOrder: tabs.map((tab) => tab.tabId),
    activeTabId,
  });
}

afterEach(() => {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

describe("T10 Area 1: requestClose routes through the coordinator", () => {
  it("active-member close activates the survivor at the group's position", () => {
    seedEpicTabs(
      [
        { tabId: "tab-a", epicId: "epic-a", name: "A" },
        { tabId: "tab-b", epicId: "epic-b", name: "B" },
      ],
      "tab-a",
    );
    const a: TabRef = { kind: "epic", id: "tab-a" };
    const b: TabRef = { kind: "epic", id: "tab-b" };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-1",
          left: { kind: "tab", ref: a },
          right: { kind: "tab", ref: b },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-1",
      stripOrder: [a, b],
      systemTabs: { history: null, settings: null },
    });

    const tabA = getHeaderTabs().find((tab) => tab.id === "tab-a");
    if (tabA === undefined) throw new Error("expected tab-a");
    tabRequestClose(tabA);

    // The split collapses to the survivor as a bare tab item, and that item
    // becomes active - not left dangling or defaulted to a neighbor.
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:tab-b", ref: b },
    ]);
    expect(useTabsStore.getState().activeItemId).toBe("tab:epic:tab-b");
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-b"]);
  });

  it("background close leaves activeItemId unchanged", () => {
    seedEpicTabs(
      [
        { tabId: "tab-a", epicId: "epic-a", name: "A" },
        { tabId: "tab-b", epicId: "epic-b", name: "B" },
      ],
      "tab-a",
    );
    const a: TabRef = { kind: "epic", id: "tab-a" };
    const b: TabRef = { kind: "epic", id: "tab-b" };
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: "tab:epic:tab-a", ref: a },
        { kind: "tab", id: "tab:epic:tab-b", ref: b },
      ],
      activeItemId: "tab:epic:tab-a",
      stripOrder: [a, b],
      systemTabs: { history: null, settings: null },
    });

    const tabB = getHeaderTabs().find((tab) => tab.id === "tab-b");
    if (tabB === undefined) throw new Error("expected tab-b");
    tabRequestClose(tabB);

    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:tab-a", ref: a },
    ]);
    // The active tab was never touched by this close.
    expect(useTabsStore.getState().activeItemId).toBe("tab:epic:tab-a");
  });

  it("route-backing close beside a fillable (empty) side removes the whole group with neighbor fallback", () => {
    seedEpicTabs(
      [
        { tabId: "tab-a", epicId: "epic-a", name: "A" },
        { tabId: "tab-c", epicId: "epic-c", name: "C" },
      ],
      "tab-a",
    );
    const a: TabRef = { kind: "epic", id: "tab-a" };
    const c: TabRef = { kind: "epic", id: "tab-c" };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-1",
          left: { kind: "tab", ref: a },
          right: { kind: "empty" },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        { kind: "tab", id: "tab:epic:tab-c", ref: c },
      ],
      activeItemId: "split-1",
      stripOrder: [a, c],
      systemTabs: { history: null, settings: null },
    });

    const tabA = getHeaderTabs().find((tab) => tab.id === "tab-a");
    if (tabA === undefined) throw new Error("expected tab-a");
    tabRequestClose(tabA);

    // The split had no live survivor (the other side was empty), so the
    // whole group is removed and the neighboring item becomes active.
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:tab-c", ref: c },
    ]);
    expect(useTabsStore.getState().activeItemId).toBe("tab:epic:tab-c");
  });

  it("closes a draft tab through the coordinator, removing it from both the source store and the layout", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const draftRef: TabRef = { kind: "draft", id: "draft-a" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: "tab:draft:draft-a", ref: draftRef }],
      activeItemId: "tab:draft:draft-a",
      stripOrder: [draftRef],
      systemTabs: { history: null, settings: null },
    });

    const draftTab = getHeaderTabs().find((tab) => tab.id === "draft-a");
    if (draftTab === undefined) throw new Error("expected draft-a");
    tabRequestClose(draftTab);

    expect(useTabsStore.getState().items).toEqual([]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("closes the history system tab through the coordinator", () => {
    const historyRef: TabRef = { kind: "history", id: "history" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: "tab:history:history", ref: historyRef }],
      activeItemId: "tab:history:history",
      stripOrder: [historyRef],
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: null,
        },
        settings: null,
      },
    });

    const historyTab = getHeaderTabs().find((tab) => tab.kind === "history");
    if (historyTab === undefined) throw new Error("expected history tab");
    tabRequestClose(historyTab);

    expect(useTabsStore.getState().items).toEqual([]);
    expect(useTabsStore.getState().systemTabs.history).toBeNull();
  });
});
