import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState, EpicNodeRef } from "@/stores/epics/canvas/types";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  collectCanvasWideRetainedChatMembership,
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
  subscribeTileSurfaceMembership,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { MAX_RETAINED_TOP_LEVEL_SURFACES } from "@/stores/tabs/top-level-surface-retention";
import { RETAINED_PANE_CHAT_CAP } from "@/stores/epics/canvas/retained-pane-chats";
import {
  getTileSurfaceEnvironment,
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import {
  reportChatRemoteDeletionState,
  resetChatRemoteDeletionRegistryForTesting,
  subscribeChatRemoteDeletion,
} from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";

function chatRef(instanceId: string): EpicNodeRef {
  return {
    id: instanceId,
    instanceId,
    type: "chat",
    name: `Chat ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function terminalRef(instanceId: string): EpicNodeRef {
  return {
    id: instanceId,
    instanceId,
    type: "terminal-agent",
    name: `Terminal ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function canvasWithChat(instanceId: string, paneId: string): EpicCanvasState {
  return {
    root: pane(paneId, [instanceId]),
    activePaneId: paneId,
    tilesByInstanceId: { [instanceId]: chatRef(instanceId) },
    sizesByGroupId: {},
  };
}

function seedSingleTabStrip(
  refs: ReadonlyArray<TabRef>,
  activeRef: TabRef,
): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    })),
    activeItemId: `tab:${activeRef.kind}:${activeRef.id}`,
    stripOrder: refs,
  }));
}

function resetAll(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
  resetChatRemoteDeletionRegistryForTesting();
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
}

describe("collectCanvasWideRetainedChatMembership (layer 1, pure)", () => {
  afterEach(() => resetChatRemoteDeletionRegistryForTesting());

  it("includes a chat tile that is its pane's active tab", () => {
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvasWithChat("chat-inst", "p1"),
    });
    expect(membership.get("chat-inst")).toBe("tab-1");
  });

  it("excludes a non-chat tile even when it is the active tab", () => {
    const term = terminalRef("term-inst");
    const canvas: EpicCanvasState = {
      root: pane("p1", ["term-inst"]),
      activePaneId: "p1",
      tilesByInstanceId: { "term-inst": term },
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.size).toBe(0);
  });

  it("excludes a background chat the pane has never activated", () => {
    // Retention is driven by `activationHistory`, so a tab that has only ever
    // sat in the strip (a restored canvas, a background open) earns no slot
    // until it is actually visited.
    const canvas: EpicCanvasState = {
      root: {
        ...pane("p1", ["chat-front", "chat-back"]),
        activeTabId: "chat-front",
      },
      activePaneId: "p1",
      tilesByInstanceId: {
        "chat-front": chatRef("chat-front"),
        "chat-back": chatRef("chat-back"),
      },
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.has("chat-front")).toBe(true);
    expect(membership.has("chat-back")).toBe(false);
  });

  it("retains a deselected chat the pane recently had active", () => {
    // The churn fix: `chat-back` was the front tab a moment ago, so its
    // surface stays a member and returning to it is a visibility toggle
    // rather than an unmount plus a re-converging scroll restore.
    const canvas: EpicCanvasState = {
      root: {
        ...pane("p1", ["chat-front", "chat-back"]),
        activeTabId: "chat-front",
        activationHistory: ["chat-front", "chat-back"],
      },
      activePaneId: "p1",
      tilesByInstanceId: {
        "chat-front": chatRef("chat-front"),
        "chat-back": chatRef("chat-back"),
      },
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.get("chat-front")).toBe("tab-1");
    expect(membership.get("chat-back")).toBe("tab-1");
  });

  it("retains a chat sitting under a non-chat active tab", () => {
    // The filmed case: an artifact tab covers the chat in the same pane. The
    // chat is not selected and must still be a member.
    const canvas: EpicCanvasState = {
      root: {
        ...pane("p1", ["term-front", "chat-under"]),
        activeTabId: "term-front",
        activationHistory: ["term-front", "chat-under"],
      },
      activePaneId: "p1",
      tilesByInstanceId: {
        "term-front": terminalRef("term-front"),
        "chat-under": chatRef("chat-under"),
      },
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.get("chat-under")).toBe("tab-1");
    expect(membership.has("term-front")).toBe(false);
  });

  it("cold review F1: an ineligible chat must not shift the window, stranding a member with no slot", () => {
    // The window is capped and selection skips-and-keeps-filling, so applying
    // eligibility DURING selection would make membership and the pane's
    // rendered set two SHIFTED windows rather than a subset and a superset.
    // Here `chat-a` is active but ineligible (a published-copy takeover
    // reports it through the deletion registry). The pane renders the
    // kind-only window [chat-a, chat-b]; membership must therefore be a
    // SUBSET of that - never [chat-b, chat-c], which would leave `chat-c` a
    // member whose slot nothing renders, its hosted body stranded mounted on
    // a disconnected anchor holding a session lease.
    reportChatRemoteDeletionState("chat-a", true);
    const instanceIds = ["chat-a", "chat-b", "chat-c"];
    const canvas: EpicCanvasState = {
      root: {
        ...pane("p1", instanceIds),
        activeTabId: "chat-a",
        activationHistory: ["chat-a", "chat-b", "chat-c"],
      },
      activePaneId: "p1",
      tilesByInstanceId: Object.fromEntries(
        instanceIds.map((id) => [id, chatRef(id)]),
      ),
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.has("chat-a")).toBe(false);
    expect(membership.has("chat-b")).toBe(true);
    expect(membership.has("chat-c")).toBe(false);
  });

  it("caps retention per pane, dropping the least recently active chat", () => {
    const instanceIds = ["chat-a", "chat-b", "chat-c"];
    const canvas: EpicCanvasState = {
      root: {
        ...pane("p1", instanceIds),
        activeTabId: "chat-a",
        activationHistory: ["chat-a", "chat-b", "chat-c"],
      },
      activePaneId: "p1",
      tilesByInstanceId: Object.fromEntries(
        instanceIds.map((id) => [id, chatRef(id)]),
      ),
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.size).toBe(RETAINED_PANE_CHAT_CAP);
    expect(membership.has("chat-a")).toBe(true);
    expect(membership.has("chat-b")).toBe(true);
    expect(membership.has("chat-c")).toBe(false);
  });

  it("falls back to the first tab (resolveActivePaneTab wiring) when activeTabId is stale", () => {
    const canvas: EpicCanvasState = {
      root: { ...pane("p1", ["chat-a"]), activeTabId: "gone" },
      activePaneId: "p1",
      tilesByInstanceId: { "chat-a": chatRef("chat-a") },
      sizesByGroupId: {},
    };
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvas,
    });
    expect(membership.get("chat-a")).toBe("tab-1");
  });

  it("walks every pane across every open top-level tab", () => {
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvasWithChat("chat-1", "p1"),
      "tab-2": canvasWithChat("chat-2", "p1"),
    });
    expect(membership.get("chat-1")).toBe("tab-1");
    expect(membership.get("chat-2")).toBe("tab-2");
  });

  it("design-review F2: excludes a chat that is remote-deleted even though it is the active tab", () => {
    reportChatRemoteDeletionState("chat-deleted", true);
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": canvasWithChat("chat-deleted", "p1"),
    });
    expect(membership.size).toBe(0);
  });

  it("ignores a tab with a null (empty-shell) canvas root", () => {
    const membership = collectCanvasWideRetainedChatMembership({
      "tab-1": {
        root: null,
        activePaneId: null,
        tilesByInstanceId: {},
        sizesByGroupId: {},
      },
    });
    expect(membership.size).toBe(0);
  });
});

describe("tile surface membership - live store integration", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("stays continuous across a same-pane reorder (single EpicCanvasStore commit)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    // Reorder: add a second (background) tab, then swap which is active -
    // the tracked instance itself never structurally moves.
    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": {
          ...canvasWithChat("chat-1", "p1"),
          root: {
            ...pane("p1", ["chat-1", "chat-2"]),
            activeTabId: "chat-1",
          },
          tilesByInstanceId: {
            "chat-1": chatRef("chat-1"),
            "chat-2": chatRef("chat-2"),
          },
        },
      },
    }));
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
  });

  it("stays continuous across a cross-pane move (instanceId preserved, pane changes)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": canvasWithChat("chat-1", "p2"),
      },
    }));
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
  });

  it("removes membership on close (permanent unmount)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": {
          root: null,
          activePaneId: null,
          tilesByInstanceId: {},
          sizesByGroupId: {},
        },
      },
    }));
    expect(getTileSurfaceMembership().has("chat-1")).toBe(false);
  });

  it("keeps a chat's record across a pane tab switch, and drops it once retention evicts it", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: {
        "tab-1": {
          root: { ...pane("p1", ["chat-1", "term-1"]), activeTabId: "chat-1" },
          activePaneId: "p1",
          tilesByInstanceId: {
            "chat-1": chatRef("chat-1"),
            "term-1": terminalRef("term-1"),
          },
          sizesByGroupId: {},
        },
      },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    function canvasWithActiveTab(
      activeTabId: string,
      activationHistory: ReadonlyArray<string>,
    ): EpicCanvasState {
      return {
        root: {
          ...pane("p1", ["chat-1", "term-1", "chat-2", "chat-3"]),
          activeTabId,
          activationHistory,
        },
        activePaneId: "p1",
        tilesByInstanceId: {
          "chat-1": chatRef("chat-1"),
          "term-1": terminalRef("term-1"),
          "chat-2": chatRef("chat-2"),
          "chat-3": chatRef("chat-3"),
        },
        sizesByGroupId: {},
      };
    }

    // Selecting a sibling tab no longer removes the chat's record - that
    // unmount is what made the return trip re-converge the transcript.
    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": canvasWithActiveTab("term-1", ["term-1", "chat-1"]),
      },
    }));
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": canvasWithActiveTab("chat-1", ["chat-1", "term-1"]),
      },
    }));
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    // Retention is bounded: two further chats push chat-1 past the pane cap,
    // and only then does its record go.
    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: {
        ...state.canvasByTabId,
        "tab-1": canvasWithActiveTab("chat-3", [
          "chat-3",
          "chat-2",
          "chat-1",
          "term-1",
        ]),
      },
    }));
    expect(getTileSurfaceMembership().has("chat-3")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-2")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(false);
  });

  it("evicts the least-recently-active top-level tab's chat once the retained cap is exceeded", () => {
    const ref0: TabRef = { kind: "epic", id: "epic-0" };
    const ref1: TabRef = { kind: "epic", id: "epic-1" };
    const ref2: TabRef = { kind: "epic", id: "epic-2" };
    const ref3: TabRef = { kind: "epic", id: "epic-3" };
    const ref4: TabRef = { kind: "epic", id: "epic-4" };
    const ref5: TabRef = { kind: "epic", id: "epic-5" };
    const refs = [ref0, ref1, ref2, ref3, ref4, ref5];
    useEpicCanvasStore.setState({
      tabsById: Object.fromEntries(
        refs.map((ref) => [
          ref.id,
          { tabId: ref.id, epicId: ref.id, name: ref.id },
        ]),
      ),
      canvasByTabId: Object.fromEntries(
        refs.map((ref) => [ref.id, canvasWithChat(`chat-${ref.id}`, "p1")]),
      ),
      openTabOrder: refs.map((ref) => ref.id),
      activeTabId: ref0.id,
    });
    seedSingleTabStrip(refs, ref0);
    for (const ref of [ref1, ref2, ref3, ref4, ref5]) {
      seedSingleTabStrip(refs, ref);
    }

    const membership = getTileSurfaceMembership();
    expect(membership.has("chat-epic-0")).toBe(false);
    expect(membership.has(`chat-${ref5.id}`)).toBe(true);
    const memberCount = refs.filter((ref) =>
      membership.has(`chat-${ref.id}`),
    ).length;
    expect(memberCount).toBe(MAX_RETAINED_TOP_LEVEL_SURFACES);
  });

  it(
    "header tear-off: membership never shows a false-absence frame across the " +
      "two-store (EpicCanvasStore then TabsStore) transaction, sampled at " +
      "every store/coordinator notification",
    () => {
      useEpicCanvasStore.setState({
        tabsById: {
          "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
        },
        canvasByTabId: {
          "tab-1": {
            root: {
              ...pane("p1", ["chat-1", "chat-2"]),
              activeTabId: "chat-1",
            },
            activePaneId: "p1",
            tilesByInstanceId: {
              "chat-1": chatRef("chat-1"),
              "chat-2": chatRef("chat-2"),
            },
            sizesByGroupId: {},
          },
        },
        openTabOrder: ["tab-1"],
        activeTabId: "tab-1",
      });
      seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
        kind: "epic",
        id: "tab-1",
      });
      expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

      const samples: boolean[] = [];
      const record = (): void => {
        samples.push(getTileSurfaceMembership().has("chat-1"));
      };
      const unsubCanvas = useEpicCanvasStore.subscribe(record);
      const unsubTabs = useTabsStore.subscribe(record);
      const unsubCoordinator = tabCommandCoordinator.subscribe(record);

      try {
        const placedRef = tabCommandCoordinator.createSourceRefAtStripIndex(
          0,
          () => {
            const newTabId = useEpicCanvasStore
              .getState()
              .tearOffTabIntoNewHeaderTab({
                sourceTabId: "tab-1",
                sourcePaneId: "p1",
                sourceTileTabId: "chat-1",
                insertIndex: 0,
              });
            return newTabId === null ? null : { kind: "epic", id: newTabId };
          },
        );
        expect(placedRef).not.toBeNull();
      } finally {
        unsubCanvas();
        unsubTabs();
        unsubCoordinator();
      }

      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((sampledMember) => sampledMember)).toBe(true);
      expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
    },
  );

  it("stays continuous across a real edge split (splitPaneWithTab)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: {
        "tab-1": {
          root: {
            ...pane("p1", ["chat-1", "chat-2"]),
            activeTabId: "chat-1",
          },
          activePaneId: "p1",
          tilesByInstanceId: {
            "chat-1": chatRef("chat-1"),
            "chat-2": chatRef("chat-2"),
          },
          sizesByGroupId: {},
        },
      },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    const samples: boolean[] = [];
    const record = (): void => {
      samples.push(getTileSurfaceMembership().has("chat-1"));
    };
    const unsubCanvas = useEpicCanvasStore.subscribe(record);
    const unsubMembership = subscribeTileSurfaceMembership(record);

    try {
      // Same-pane edge split: dragged tab lands in a brand-new pane; the
      // original pane keeps chat-2. Membership must keep chat-1 continuous.
      useEpicCanvasStore.getState().splitPaneWithTab("tab-1", {
        sourcePaneId: "p1",
        tabId: "chat-1",
        targetPaneId: "p1",
        position: "right",
      });
    } finally {
      unsubCanvas();
      unsubMembership();
    }

    const canvas = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (canvas === undefined) throw new Error("expected canvas for tab-1");
    expect(collectPanes(canvas.root).length).toBeGreaterThan(1);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sampledMember) => sampledMember)).toBe(true);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
  });

  it("stays continuous across wrap/dissolve (split then closeCanvasTab sibling)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: {
        "tab-1": {
          root: {
            ...pane("p1", ["chat-1", "chat-2"]),
            activeTabId: "chat-1",
          },
          activePaneId: "p1",
          tilesByInstanceId: {
            "chat-1": chatRef("chat-1"),
            "chat-2": chatRef("chat-2"),
          },
          sizesByGroupId: {},
        },
      },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-2")).toBe(false);

    const survivorSamples: boolean[] = [];
    const recordSurvivor = (): void => {
      survivorSamples.push(getTileSurfaceMembership().has("chat-1"));
    };
    const unsubCanvas = useEpicCanvasStore.subscribe(recordSurvivor);
    const unsubMembership = subscribeTileSurfaceMembership(recordSurvivor);

    try {
      useEpicCanvasStore.getState().splitPaneWithTab("tab-1", {
        sourcePaneId: "p1",
        tabId: "chat-2",
        targetPaneId: "p1",
        position: "right",
      });

      const afterSplit = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
      if (afterSplit === undefined) {
        throw new Error("expected canvas after split");
      }
      const panes = collectPanes(afterSplit.root);
      expect(panes.length).toBe(2);
      // chat-2 is now its own pane's active tab → also a member.
      expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
      expect(getTileSurfaceMembership().has("chat-2")).toBe(true);

      const chat2Pane = panes.find((p) => p.tabInstanceIds.includes("chat-2"));
      if (chat2Pane === undefined) {
        throw new Error("expected pane hosting chat-2 after split");
      }

      // Closing the sibling's only tab dissolves the split (one-child-group
      // promotion). chat-2 must leave membership; chat-1 must stay throughout.
      useEpicCanvasStore
        .getState()
        .closeCanvasTab("tab-1", chat2Pane.id, "chat-2");
    } finally {
      unsubCanvas();
      unsubMembership();
    }

    const afterDissolve = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (afterDissolve === undefined) {
      throw new Error("expected canvas after dissolve");
    }
    expect(collectPanes(afterDissolve.root).length).toBe(1);
    expect(survivorSamples.length).toBeGreaterThan(0);
    expect(survivorSamples.every((sampledMember) => sampledMember)).toBe(true);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-2")).toBe(false);
  });

  it("stays continuous across moveTabOnTabStrip (cross-pane move)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: {
        "tab-1": {
          root: {
            ...pane("p1", ["chat-1", "chat-2"]),
            activeTabId: "chat-1",
          },
          activePaneId: "p1",
          tilesByInstanceId: {
            "chat-1": chatRef("chat-1"),
            "chat-2": chatRef("chat-2"),
          },
          sizesByGroupId: {},
        },
      },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });

    // First create a real second pane via edge split, then move chat-1 onto it.
    useEpicCanvasStore.getState().splitPaneWithTab("tab-1", {
      sourcePaneId: "p1",
      tabId: "chat-2",
      targetPaneId: "p1",
      position: "right",
    });
    const afterSplit = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (afterSplit === undefined)
      throw new Error("expected canvas after split");
    const panes = collectPanes(afterSplit.root);
    expect(panes.length).toBe(2);
    const chat1Pane = panes.find((p) => p.tabInstanceIds.includes("chat-1"));
    const chat2Pane = panes.find((p) => p.tabInstanceIds.includes("chat-2"));
    if (chat1Pane === undefined || chat2Pane === undefined) {
      throw new Error("expected both panes after split");
    }
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    const samples: boolean[] = [];
    const record = (): void => {
      samples.push(getTileSurfaceMembership().has("chat-1"));
    };
    const unsubCanvas = useEpicCanvasStore.subscribe(record);
    const unsubMembership = subscribeTileSurfaceMembership(record);

    try {
      useEpicCanvasStore.getState().moveTabOnTabStrip("tab-1", {
        sourcePaneId: chat1Pane.id,
        tabId: "chat-1",
        targetPaneId: chat2Pane.id,
        targetIndex: 0,
      });
    } finally {
      unsubCanvas();
      unsubMembership();
    }

    const afterMove = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (afterMove === undefined) throw new Error("expected canvas after move");
    // chat-1 left its only-tab pane → that pane dissolved; chat-1 should still
    // be a member wherever it landed.
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sampledMember) => sampledMember)).toBe(true);
  });

  it("add-background: openTileInBackgroundTab does not touch active-chat membership", () => {
    // Correction vs brief: `openTileInPane` always activates the new tab
    // (and would deselect the prior active chat under decision #17). The
    // real "add background without switching active tab" store action is
    // `openTileInBackgroundTab`.
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

    let membershipNotifications = 0;
    const unsubMembership = subscribeTileSurfaceMembership(() => {
      membershipNotifications += 1;
    });

    try {
      useEpicCanvasStore
        .getState()
        .openTileInBackgroundTab("tab-1", chatRef("chat-2"));
    } finally {
      unsubMembership();
    }

    const canvas = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (canvas === undefined) throw new Error("expected canvas for tab-1");
    const rootPane = canvas.root;
    if (rootPane === null || rootPane.kind !== "pane") {
      throw new Error("expected single root pane after background open");
    }
    expect(rootPane.tabInstanceIds).toContain("chat-1");
    expect(rootPane.tabInstanceIds).toContain("chat-2");
    expect(rootPane.activeTabId).toBe("chat-1");
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
    expect(getTileSurfaceMembership().has("chat-2")).toBe(false);
    // Membership set is unchanged → recomputeMembership short-circuits
    // without notifying (setsEqual).
    expect(membershipNotifications).toBe(0);
  });

  it("two top-level tabs: each active chat is a member attributed to its own tabId", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-a": { tabId: "tab-a", epicId: "tab-a", name: "Tab A" },
        "tab-b": { tabId: "tab-b", epicId: "tab-b", name: "Tab B" },
      },
      canvasByTabId: {
        "tab-a": canvasWithChat("chat-a", "p1"),
        "tab-b": canvasWithChat("chat-b", "p1"),
      },
      openTabOrder: ["tab-a", "tab-b"],
      activeTabId: "tab-b",
    });
    // Activate both so layer-2 recency retains them under the cap.
    seedSingleTabStrip(
      [
        { kind: "epic", id: "tab-a" },
        { kind: "epic", id: "tab-b" },
      ],
      { kind: "epic", id: "tab-a" },
    );
    seedSingleTabStrip(
      [
        { kind: "epic", id: "tab-a" },
        { kind: "epic", id: "tab-b" },
      ],
      { kind: "epic", id: "tab-b" },
    );

    const layer1 = collectCanvasWideRetainedChatMembership(
      useEpicCanvasStore.getState().canvasByTabId,
    );
    expect(layer1.get("chat-a")).toBe("tab-a");
    expect(layer1.get("chat-b")).toBe("tab-b");

    const membership = getTileSurfaceMembership();
    expect(membership.has("chat-a")).toBe(true);
    expect(membership.has("chat-b")).toBe(true);
  });
});

describe("design-review F1: global MRU cap spans every top-level kind, not just epic", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("evicts an epic chat once the global cap-5 is exceeded by mixed-kind activations (epic-old -> 4 drafts -> epic-new)", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "epic-old": { tabId: "epic-old", epicId: "epic-old", name: "Epic Old" },
        "epic-new": { tabId: "epic-new", epicId: "epic-new", name: "Epic New" },
      },
      canvasByTabId: {
        "epic-old": canvasWithChat("chat-old", "p1"),
        "epic-new": canvasWithChat("chat-new", "p1"),
      },
      openTabOrder: ["epic-old", "epic-new"],
      activeTabId: "epic-old",
    });
    const draftId1 = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-1", null);
    const draftId2 = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-2", null);
    const draftId3 = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-3", null);
    const draftId4 = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-4", null);

    const epicOldRef: TabRef = { kind: "epic", id: "epic-old" };
    const epicNewRef: TabRef = { kind: "epic", id: "epic-new" };
    const draftRefs: ReadonlyArray<TabRef> = [
      { kind: "draft", id: draftId1 },
      { kind: "draft", id: draftId2 },
      { kind: "draft", id: draftId3 },
      { kind: "draft", id: draftId4 },
    ];
    const allRefs = [epicOldRef, ...draftRefs, epicNewRef];

    seedSingleTabStrip(allRefs, epicOldRef);
    expect(getTileSurfaceMembership().has("chat-old")).toBe(true);

    for (const draftRef of draftRefs) {
      seedSingleTabStrip(allRefs, draftRef);
    }
    seedSingleTabStrip(allRefs, epicNewRef);

    // Real global cap-5 recency: epic-old, draft-1..4, epic-new is 6 distinct
    // activations - epic-old (least recently active) must be evicted, and
    // its chat must leave membership with it.
    expect(getTileSurfaceMembership().has("chat-old")).toBe(false);
    expect(getTileSurfaceMembership().has("chat-new")).toBe(true);
  });
});

describe("design-review F2: shared eligibility discriminator (remote-deletion)", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it(
    "pin: remote-delete while hosted -> membership drops the instance and its " +
      "published environment is cleared - exactly one owner survives",
    () => {
      useEpicCanvasStore.setState({
        tabsById: {
          "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
        },
        canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
        openTabOrder: ["tab-1"],
        activeTabId: "tab-1",
      });
      seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
        kind: "epic",
        id: "tab-1",
      });
      expect(getTileSurfaceMembership().has("chat-1")).toBe(true);

      // Mirrors what `TileSurfaceSlot` does once mounted for a real hosted
      // chat - a published environment is the thing that would otherwise
      // linger as a second, orphaned owner alongside the inline
      // `DeletedArtifactBody` (design-review slice-4 finding 2).
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          placement: {
            epicId: "epic-1",
            viewTabId: "tab-1",
            paneId: "p1",
            hostId: TEST_HOST_ID,
          },
        }),
      );
      expect(getTileSurfaceEnvironment("chat-1")).not.toBeNull();

      // Mirrors what `ActiveTabBody`'s effect reports the instant
      // `computeIsRemoteDeleted` flips true for this chat.
      reportChatRemoteDeletionState("chat-1", true);

      expect(getTileSurfaceMembership().has("chat-1")).toBe(false);
      expect(getTileSurfaceEnvironment("chat-1")).toBeNull();
    },
  );

  it("re-admits the chat to membership once the deletion is reverted", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    reportChatRemoteDeletionState("chat-1", true);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(false);

    reportChatRemoteDeletionState("chat-1", false);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
  });

  it("reset notifies subscribers and immediately recomputes remote-deletion membership", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChat("chat-1", "p1") },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    reportChatRemoteDeletionState("chat-1", true);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(false);

    let notifications = 0;
    const unsubscribe = subscribeChatRemoteDeletion(() => {
      notifications += 1;
    });
    onTestFinished(unsubscribe);
    resetChatRemoteDeletionRegistryForTesting();

    expect(notifications).toBe(1);
    expect(getTileSurfaceMembership().has("chat-1")).toBe(true);
  });
});
