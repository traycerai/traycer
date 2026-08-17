import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import {
  collectPanes,
  findPanePath,
  getNodeAtPath,
} from "@/stores/epics/canvas/tile-tree";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { resetTileSurfaceMembershipForTesting } from "@/components/epic-canvas/surface-host/tile-surface-membership";
import {
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { resetTileSurfaceGeometryCoordinatorForTesting } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import {
  buildSyntheticTileSurfaceEnvironment,
  createSyntheticTileSurfaceBodyRenderer,
} from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";

/**
 * The global `MockResizeObserver` installed by `test-browser-apis.ts` is a
 * total no-op - it never invokes its callback, so a rect change after the
 * initial synchronous registration apply (see
 * `tile-surface-geometry-coordinator.ts`'s "direct-flush" contract) has no
 * way to reach an already-mounted record without this. Installing a
 * controllable replacement at MODULE LOAD TIME (before any test body runs,
 * matching `tile-surface-geometry-coordinator.test.ts`'s own technique) lets
 * the geometry-retention-while-hidden suite below fire real RO callbacks on
 * demand to simulate a slot's rect changing after mount.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    controllableResizeObserverInstances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

let controllableResizeObserverInstances: ControllableResizeObserver[] = [];

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

function triggerResizeObserverCallbacks(): void {
  for (const instance of controllableResizeObserverInstances) {
    instance.callback([], instance);
  }
}

function stubElementRect(
  element: Element,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  element.getBoundingClientRect = () => fakeDomRect(rect);
}

function chatRef(instanceId: string) {
  return {
    id: instanceId,
    instanceId,
    type: "chat" as const,
    name: `Chat ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function terminalRef(instanceId: string) {
  return {
    id: instanceId,
    instanceId,
    type: "terminal-agent" as const,
    name: `Terminal ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function canvasWithChats(
  paneId: string,
  instanceIds: ReadonlyArray<string>,
): EpicCanvasState {
  return {
    root: pane(paneId, instanceIds),
    activePaneId: paneId,
    tilesByInstanceId: Object.fromEntries(
      instanceIds.map((id) => [id, chatRef(id)]),
    ),
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
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
  resetTileSurfaceGeometryCoordinatorForTesting();
}

describe("StableTileSurfaceHost lifecycle matrix (real store/coordinator, synthetic body)", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("keeps the synthetic body mounted exactly once across move / edge-split / wrap-dissolve / cross-pane-move / header tear-off", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1", "chat-2"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment("chat-1", {}),
    );

    const renderer = createSyntheticTileSurfaceBodyRenderer();
    render(
      <StableTileSurfaceHost renderRecordBody={renderer.renderRecordBody} />,
    );

    expect(
      screen.getByTestId("synthetic-tile-surface-body-chat-1"),
    ).not.toBeNull();
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // Same-pane reorder via the real action (design-review F3 - was a
    // handcrafted setState).
    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip("tab-1", {
        sourcePaneId: "p1",
        tabId: "chat-1",
        targetPaneId: "p1",
        targetIndex: 2,
      });
    });
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // Real edge split: chat-1 moves into its own pane, right of p1.
    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab("tab-1", {
        sourcePaneId: "p1",
        tabId: "chat-1",
        targetPaneId: "p1",
        position: "right",
      });
    });
    const afterSplit = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (afterSplit === undefined) throw new Error("expected canvas");
    const chat1PaneAfterSplit = collectPanes(afterSplit.root).find((p) =>
      p.tabInstanceIds.includes("chat-1"),
    );
    if (chat1PaneAfterSplit === undefined) {
      throw new Error("expected chat-1's own pane");
    }
    const chat1PaneId = chat1PaneAfterSplit.id;
    const rootGroupId =
      afterSplit.root !== null && afterSplit.root.kind === "group"
        ? afterSplit.root.id
        : null;
    if (rootGroupId === null) throw new Error("expected a root group");
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // Wrap (design-review F3 - the old test's same-direction split
    // flattened 2->3 siblings instead of wrapping): a genuinely
    // PERPENDICULAR split ("bottom" against the root's "horizontal" group)
    // around chat-1's OWN pane. chat-3 rides along purely as the wrap
    // partner and is dissolved back out below; the tracked instance
    // (chat-1) never changes pane and never remounts.
    act(() => {
      useEpicCanvasStore
        .getState()
        .openTileInBackgroundTab("tab-1", chatRef("chat-3"));
    });
    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab("tab-1", {
        sourcePaneId: chat1PaneId,
        tabId: "chat-3",
        targetPaneId: chat1PaneId,
        position: "bottom",
      });
    });
    const afterWrap = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (afterWrap === undefined || afterWrap.root === null) {
      throw new Error("expected canvas");
    }
    const wrapRoot = afterWrap.root;
    const wrapPath = findPanePath(wrapRoot, chat1PaneId);
    if (wrapPath === null || wrapPath.length === 0) {
      throw new Error("expected chat-1's pane to be nested under a wrap group");
    }
    const wrapParent = getNodeAtPath(wrapRoot, wrapPath.slice(0, -1));
    if (wrapParent.kind !== "group") throw new Error("expected a group");
    // The wrap genuinely nests chat-1's pane under a FRESH group, distinct
    // from the original root group - proof this is a real wrap, not a flat
    // same-direction insertion.
    expect(wrapParent.id).not.toBe(rootGroupId);
    expect(wrapParent.direction).toBe("vertical");
    expect(wrapParent.children).toHaveLength(2);
    const chat1PaneAfterWrap = collectPanes(afterWrap.root).find(
      (p) => p.id === chat1PaneId,
    );
    if (chat1PaneAfterWrap === undefined) throw new Error("expected pane");
    expect(chat1PaneAfterWrap.tabInstanceIds).toEqual(["chat-1"]);
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // Dissolve: closing chat-3's pane (the wrap group's other child) leaves
    // the wrap group with exactly one survivor, which the tree promotes
    // back into the ORIGINAL group's slot - a genuine one-child-group
    // promotion, not the old test's flat 3-to-2 sibling removal.
    const chat3Pane = collectPanes(afterWrap.root).find((p) =>
      p.tabInstanceIds.includes("chat-3"),
    );
    if (chat3Pane === undefined) throw new Error("expected chat-3's pane");
    act(() => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab("tab-1", chat3Pane.id, "chat-3");
    });
    const afterDissolve = useEpicCanvasStore.getState().canvasByTabId["tab-1"];
    if (afterDissolve === undefined) throw new Error("expected canvas");
    if (afterDissolve.root === null || afterDissolve.root.kind !== "group") {
      throw new Error("expected the outer group to survive");
    }
    expect(afterDissolve.root.id).toBe(rootGroupId);
    expect(
      afterDissolve.root.children.some(
        (child) => child.kind === "pane" && child.id === chat1PaneId,
      ),
    ).toBe(true);
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // Cross-pane move via the real action: merge chat-1 back into p1.
    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip("tab-1", {
        sourcePaneId: chat1PaneId,
        tabId: "chat-1",
        targetPaneId: "p1",
        targetIndex: 0,
      });
    });
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // Header tear-off: real coordinator transaction, source/destination
    // strips split across two stores. chat-1's own pane dissolved back
    // into p1 above, so p1 is the sole remaining pane.
    act(() => {
      tabCommandCoordinator.createSourceRefAtStripIndex(0, () => {
        const newTabId = useEpicCanvasStore
          .getState()
          .tearOffTabIntoNewHeaderTab({
            sourceTabId: "tab-1",
            sourcePaneId: "p1",
            sourceTileTabId: "chat-1",
            insertIndex: 0,
          });
        return newTabId === null ? null : { kind: "epic", id: newTabId };
      });
    });
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);
    expect(
      screen.getByTestId("synthetic-tile-surface-body-chat-1"),
    ).not.toBeNull();
  });

  it("deselecting a chat's inner tab keeps its body mounted; only real membership loss unmounts it, and the record then stays dormant until a fresh publish", () => {
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
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment("chat-1", {}),
    );

    const renderer = createSyntheticTileSurfaceBodyRenderer();
    render(
      <StableTileSurfaceHost renderRecordBody={renderer.renderRecordBody} />,
    );
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    function setPaneRoot(
      tabInstanceIds: ReadonlyArray<string>,
      activeTabId: string,
      activationHistory: ReadonlyArray<string>,
    ): void {
      act(() => {
        useEpicCanvasStore.setState((state) => {
          const current = state.canvasByTabId["tab-1"];
          if (current === undefined) throw new Error("expected canvas");
          return {
            canvasByTabId: {
              ...state.canvasByTabId,
              "tab-1": {
                ...current,
                root: {
                  ...pane("p1", tabInstanceIds),
                  activeTabId,
                  activationHistory,
                },
              },
            },
          };
        });
      });
    }

    // Selecting the sibling tab retains chat-1: its record survives, its body
    // is never unmounted, and it only stops being PRESENTED. This is what
    // stops the transcript re-converging on the way back.
    setPaneRoot(["chat-1", "term-1"], "term-1", ["term-1", "chat-1"]);
    expect(
      screen.getByTestId("synthetic-tile-surface-body-chat-1"),
    ).not.toBeNull();
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // ...and coming back is not a remount at all.
    setPaneRoot(["chat-1", "term-1"], "chat-1", ["chat-1", "term-1"]);
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);

    // A REAL membership loss (the tab is closed) still unmounts.
    setPaneRoot(["term-1"], "term-1", ["term-1"]);
    expect(
      screen.queryByTestId("synthetic-tile-surface-body-chat-1"),
    ).toBeNull();
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(1);

    setPaneRoot(["chat-1", "term-1"], "chat-1", ["chat-1", "term-1"]);
    // Membership re-includes chat-1, but the registry has no unregister API -
    // it already deleted the record on loss (F2). No body without a fresh
    // publish: this is the dormant state, not an automatic remount.
    expect(
      screen.queryByTestId("synthetic-tile-surface-body-chat-1"),
    ).toBeNull();
    expect(renderer.mountCount("chat-1")).toBe(1);

    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {}),
      );
    });
    expect(
      screen.getByTestId("synthetic-tile-surface-body-chat-1"),
    ).not.toBeNull();
    expect(renderer.mountCount("chat-1")).toBe(2);
    expect(renderer.unmountCount("chat-1")).toBe(1);
  });
});

describe("StableTileSurfaceHost presentation contract (design-review F1)", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    cleanup();
    resetAll();
  });

  function seedOneChat(): void {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
  }

  it("plane root carries no aria-hidden of its own", () => {
    seedOneChat();
    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    const host = screen.getByTestId("stable-tile-surface-host");
    expect(host.hasAttribute("aria-hidden")).toBe(false);
  });

  it("a visible record is not hidden by any ancestor and stays painted", () => {
    seedOneChat();
    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: true, topLevelFocused: false },
        }),
      );
    });
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    // No ancestor (including the plane root) carries aria-hidden="true" -
    // an aria-hidden ancestor overrides a descendant's own attribute, which
    // is exactly the F1 defect: the plane used to shroud every record.
    expect(record.closest('[aria-hidden="true"]')).toBeNull();
    expect(record.getAttribute("aria-hidden")).toBe("false");
    expect(record.hasAttribute("inert")).toBe(false);
    expect(record.classList.contains("invisible")).toBe(false);
    expect(record.classList.contains("opacity-0")).toBe(false);
  });

  it("a top-level-hidden record is aria-hidden, inert, AND non-painted", () => {
    seedOneChat();
    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: false, topLevelFocused: false },
        }),
      );
    });
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(record.getAttribute("aria-hidden")).toBe("true");
    expect(record.hasAttribute("inert")).toBe(true);
    // The F1 gap: aria-hidden/inert alone do not stop painting - only real
    // non-paint rules do. Opacity also flushes independently composited child
    // layers that Electron can otherwise retain after visibility changes.
    expect(record.classList.contains("invisible")).toBe(true);
    expect(record.classList.contains("opacity-0")).toBe(true);
  });

  it("a retained-but-deselected record is aria-hidden, inert, AND non-painted even though its top level is visible", () => {
    // Retention keeps a chat's record alive while another tab holds the
    // pane's foreground. Every record of a pane is positioned on that same
    // pane rect, so a retained one that kept painting would sit exactly on
    // top of the selected chat - `topLevelVisible` alone can no longer answer
    // "is this painting".
    seedOneChat();
    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: true, topLevelFocused: false },
          canvasActivity: { tabSelected: false, canvasPaneActive: false },
        }),
      );
    });
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(record.getAttribute("aria-hidden")).toBe("true");
    expect(record.hasAttribute("inert")).toBe(true);
    expect(record.classList.contains("invisible")).toBe(true);
    expect(record.classList.contains("opacity-0")).toBe(true);

    // Re-selecting the tab paints it again - the record follows the freshly
    // published `tabSelected`, with no remount and no geometry re-measure.
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: true, topLevelFocused: false },
          canvasActivity: { tabSelected: true, canvasPaneActive: false },
        }),
      );
    });
    expect(record.getAttribute("aria-hidden")).toBe("false");
    expect(record.hasAttribute("inert")).toBe(false);
    expect(record.classList.contains("invisible")).toBe(false);
  });

  it("pins the pointer-event split, overflow clipping, and no positive record z-index", () => {
    seedOneChat();
    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    const host = screen.getByTestId("stable-tile-surface-host");
    expect(host.classList.contains("pointer-events-none")).toBe(true);
    expect(host.classList.contains("z-0")).toBe(true);

    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {}),
      );
    });
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(record.classList.contains("pointer-events-auto")).toBe(true);
    expect(record.classList.contains("overflow-hidden")).toBe(true);
    expect(
      [...record.classList].some((className) => /^z-[1-9]/.test(className)),
    ).toBe(false);
  });
});

describe("StableTileSurfaceHost presentation-loss blur (design-review finding 5)", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    cleanup();
    resetAll();
  });

  function seedOneChat(): void {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
  }

  it("blurs a focused descendant of a record that goes top-level-hidden", () => {
    seedOneChat();
    render(
      <StableTileSurfaceHost
        renderRecordBody={() => (
          <button type="button" data-testid="hosted-focus-target">
            focus me
          </button>
        )}
      />,
    );
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: true, topLevelFocused: true },
        }),
      );
    });
    const target = screen.getByTestId("hosted-focus-target");
    act(() => {
      target.focus();
    });
    expect(document.activeElement).toBe(target);

    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: false, topLevelFocused: false },
        }),
      );
    });
    expect(document.activeElement).not.toBe(target);
  });

  it("leaves focus alone when the newly-hidden record has no focused descendant", () => {
    seedOneChat();
    render(
      <StableTileSurfaceHost
        renderRecordBody={() => (
          <button type="button" data-testid="hosted-focus-target">
            focus me
          </button>
        )}
      />,
    );
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: true, topLevelFocused: true },
        }),
      );
    });
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    expect(document.activeElement).toBe(outside);

    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          presentation: { topLevelVisible: false, topLevelFocused: false },
        }),
      );
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("StableTileSurfaceHost hosted DOM identity", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("stamps the record with its instanceId always, and its paneId once ready", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });

    const renderer = createSyntheticTileSurfaceBodyRenderer();
    render(
      <StableTileSurfaceHost renderRecordBody={renderer.renderRecordBody} />,
    );

    const dormantRecord = screen.getByTestId(
      "stable-tile-surface-record-chat-1",
    );
    expect(dormantRecord.getAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE)).toBe(
      "chat-1",
    );
    expect(dormantRecord.hasAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE)).toBe(
      false,
    );

    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {}),
      );
    });

    const readyRecord = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(readyRecord.getAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE)).toBe("p1");
  });
});

describe("StableTileSurfaceHost geometry under StrictMode replay", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("survives setup->cleanup->setup StrictMode replay and still applies the correct host-relative rect", () => {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });

    const slot = document.createElement("div");
    document.body.appendChild(slot);

    // Attribute/identity-keyed rect stub, installed BEFORE render: the host
    // element does not exist yet, so it cannot be stubbed by reference the
    // way `slot` can - `data-testid="stable-tile-surface-host"` is a static
    // JSX attribute already present on the node by the time its callback
    // ref fires, so matching on it works regardless of which of StrictMode's
    // two constructed instances ends up live. Every other element falls back
    // to the zero rect jsdom already reports by default, so there is no need
    // to preserve or re-invoke the original implementation.
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "getBoundingClientRect",
    );
    Element.prototype.getBoundingClientRect = function (
      this: Element,
    ): DOMRect {
      if (this === slot) {
        return fakeDomRect({ left: 120, top: 130, width: 200, height: 100 });
      }
      if (this.getAttribute("data-testid") === "stable-tile-surface-host") {
        return fakeDomRect({ left: 20, top: 30, width: 800, height: 600 });
      }
      return fakeDomRect({ left: 0, top: 0, width: 0, height: 0 });
    };

    try {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment("chat-1", {
          services: {
            openEpicHandle: {} as never,
            geometryAnchorElement: slot,
            panePortalContainer: null,
            isPaneFocusedNow: () => false,
          },
        }),
      );

      const renderer = createSyntheticTileSurfaceBodyRenderer();
      render(
        <StrictMode>
          <StableTileSurfaceHost renderRecordBody={renderer.renderRecordBody} />
        </StrictMode>,
      );

      const record = screen.getByTestId("stable-tile-surface-record-chat-1");
      expect(record.style.transform).toBe("translate(100px, 100px)");
      expect(record.style.width).toBe("200px");
      expect(record.style.height).toBe("100px");
    } finally {
      if (originalDescriptor !== undefined) {
        Object.defineProperty(
          Element.prototype,
          "getBoundingClientRect",
          originalDescriptor,
        );
      } else {
        Reflect.deleteProperty(Element.prototype, "getBoundingClientRect");
      }
      slot.remove();
    }
  });
});

describe("StableTileSurfaceHost geometry retention while hidden (confirmed scroll regression)", () => {
  beforeEach(() => {
    controllableResizeObserverInstances = [];
    resetAll();
  });
  afterEach(() => {
    cleanup();
    resetAll();
  });

  function seedOneChat(): void {
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
  }

  function publishWithAnchor(
    instanceId: string,
    slot: HTMLElement,
    presentation: { topLevelVisible: boolean; topLevelFocused: boolean },
  ): void {
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment(instanceId, {
        presentation,
        services: {
          openEpicHandle: {} as never,
          geometryAnchorElement: slot,
          panePortalContainer: null,
          isPaneFocusedNow: () => false,
        },
      }),
    );
  }

  it("a visible record still accepts a legitimate 0x0 rect from its slot", () => {
    seedOneChat();
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    stubElementRect(slot, { left: 10, top: 20, width: 300, height: 200 });

    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    act(() => {
      publishWithAnchor("chat-1", slot, {
        topLevelVisible: true,
        topLevelFocused: false,
      });
    });
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(record.style.transform).toBe("translate(10px, 20px)");
    expect(record.style.width).toBe("300px");
    expect(record.style.height).toBe("200px");

    act(() => {
      stubElementRect(slot, { left: 10, top: 20, width: 0, height: 0 });
      triggerResizeObserverCallbacks();
    });

    // A REAL zero rect from a still-visible record (e.g. a collapsed pane)
    // must be trusted, not treated as a stale-measurement artifact.
    expect(record.style.width).toBe("0px");
    expect(record.style.height).toBe("0px");
    slot.remove();
  });

  it("a top-level-hidden record retains its last positive width/height/transform when its slot recomputes as 0x0", () => {
    seedOneChat();
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    stubElementRect(slot, { left: 10, top: 20, width: 300, height: 200 });

    render(<StableTileSurfaceHost renderRecordBody={() => null} />);
    act(() => {
      publishWithAnchor("chat-1", slot, {
        topLevelVisible: true,
        topLevelFocused: false,
      });
    });
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(record.style.transform).toBe("translate(10px, 20px)");
    expect(record.style.width).toBe("300px");
    expect(record.style.height).toBe("200px");

    act(() => {
      publishWithAnchor("chat-1", slot, {
        topLevelVisible: false,
        topLevelFocused: false,
      });
    });

    act(() => {
      // Simulates the hidden pane's slot collapsing under a display:none
      // ancestor and reporting a 0x0 rect at a different position - exactly
      // what a shared ResizeObserver batch delivers for every currently
      // registered slot, not only the one that actually moved.
      stubElementRect(slot, { left: 999, top: 999, width: 0, height: 0 });
      triggerResizeObserverCallbacks();
    });

    expect(record.style.transform).toBe("translate(10px, 20px)");
    expect(record.style.width).toBe("300px");
    expect(record.style.height).toBe("200px");
    slot.remove();
  });

  it("a record born hidden at 0x0 does not invoke renderRecordBody until the first positive rect, then stays mounted and a re-show applies fresh geometry", () => {
    seedOneChat();
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    stubElementRect(slot, { left: 0, top: 0, width: 0, height: 0 });

    const renderer = createSyntheticTileSurfaceBodyRenderer();
    const renderRecordBody = vi.fn(renderer.renderRecordBody);
    render(<StableTileSurfaceHost renderRecordBody={renderRecordBody} />);
    act(() => {
      publishWithAnchor("chat-1", slot, {
        topLevelVisible: false,
        topLevelFocused: false,
      });
    });

    expect(renderRecordBody).not.toHaveBeenCalled();
    expect(renderer.mountCount("chat-1")).toBe(0);
    expect(
      screen.queryByTestId("synthetic-tile-surface-body-chat-1"),
    ).toBeNull();

    act(() => {
      stubElementRect(slot, { left: 10, top: 20, width: 300, height: 200 });
      triggerResizeObserverCallbacks();
    });

    expect(renderRecordBody).toHaveBeenCalled();
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(
      screen.getByTestId("synthetic-tile-surface-body-chat-1"),
    ).not.toBeNull();

    act(() => {
      stubElementRect(slot, { left: 40, top: 60, width: 500, height: 400 });
      publishWithAnchor("chat-1", slot, {
        topLevelVisible: true,
        topLevelFocused: false,
      });
      triggerResizeObserverCallbacks();
    });

    // Still mounted exactly once - a re-show is a geometry refresh, not a
    // remount.
    expect(renderer.mountCount("chat-1")).toBe(1);
    expect(renderer.unmountCount("chat-1")).toBe(0);
    const record = screen.getByTestId("stable-tile-surface-record-chat-1");
    expect(record.style.transform).toBe("translate(40px, 60px)");
    expect(record.style.width).toBe("500px");
    expect(record.style.height).toBe("400px");
    slot.remove();
  });
});

function fakeDomRect(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  };
}

describe("default-on proof (slice 6)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    resetAll();
  });
  afterEach(() => {
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    resetAll();
  });

  it("TopLevelTabHost's render output mounts the stable-tile-surface-host plane with the switch enabled", () => {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId("epic-a", "epic-a", "Epic A");
    useTabsStore.setState((state) => ({
      ...state,
      items: [
        {
          kind: "tab" as const,
          id: "tab:epic:epic-a",
          ref: { kind: "epic" as const, id: "epic-a" },
        },
      ],
      activeItemId: "tab:epic:epic-a",
      stripOrder: [{ kind: "epic" as const, id: "epic-a" }],
    }));

    render(<TopLevelTabHost />);

    expect(screen.getByTestId("top-level-surface-epic-epic-a")).not.toBeNull();
    expect(screen.queryByTestId("stable-tile-surface-host")).not.toBeNull();
  });
});
