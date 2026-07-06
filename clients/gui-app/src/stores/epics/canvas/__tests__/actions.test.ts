import { describe, expect, it } from "vitest";
import {
  closeAllTabs,
  closeOtherTabs,
  closePane,
  closeRightTabs,
  closeTab,
  paneTabRefs,
  cloneEpicCanvasState,
  dropOnTabStrip,
  findActiveGitFileDiffTile,
  findPaneTabByContentId,
  openBlankTabInPane,
  openTile,
  openTileInBackgroundTab,
  openTileInPane,
  promotePreview,
  renameArtifact,
  resizeSplit,
  setActivePane,
  setActiveTab,
  splitPaneAtEdge,
  splitPaneEmpty,
  toggleGitDiffBundleFileCollapsed,
  toggleSnapshotDiffBundleFileCollapsed,
  updateGitDiffTileView,
} from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type { TilePane } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicNodeRef,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import { isBlankTileRef } from "@/stores/epics/canvas/types";
import {
  GIT_BUNDLE_CHANGES,
  GIT_FILE_A,
  GIT_FILE_A_DUP,
  GIT_FILE_B,
  CHAT_A,
  SNAPSHOT_BUNDLE_CHANGES,
  SPEC_A,
  SPEC_B,
  SPEC_C,
  TEST_HOST_ID,
  asPane,
  expectCanvasInvariants,
  paneTabIds,
  rootGroup,
  rootPane,
} from "./canvas-test-fixtures";

/** Permanent (pinned) open - `openTile` with `preview: false`. */
function openPinned(
  state: EpicCanvasState,
  node: EpicCanvasTileRef,
): EpicCanvasState {
  return openTile(state, node, false);
}

/** Preview open - `openTile` with `preview: true`. */
function openPreview(
  state: EpicCanvasState,
  node: EpicCanvasTileRef,
): EpicCanvasState {
  return openTile(state, node, true);
}

/** Max depth of the tree under `state.root` (a bare pane is depth 1). */
function getTreeDepthOf(state: EpicCanvasState): number {
  function depth(node: NonNullable<EpicCanvasState["root"]>): number {
    if (node.kind === "pane") return 1;
    return 1 + Math.max(...node.children.map((child) => depth(child)));
  }
  return state.root === null ? 0 : depth(state.root);
}

function paneById(state: EpicCanvasState, paneId: string) {
  const pane = findPaneById(state.root, paneId);
  if (pane === null) throw new Error(`expected pane ${paneId}`);
  return pane;
}

function activationContentIds(
  state: EpicCanvasState,
  pane: TilePane,
): ReadonlyArray<string> {
  return pane.activationHistory.map((instanceId) => {
    const ref = state.tilesByInstanceId[instanceId];
    if (ref === undefined) {
      throw new Error(`missing tile payload for ${instanceId}`);
    }
    return ref.id;
  });
}

describe("openTile (pinned open)", () => {
  it("seeds a root pane when canvas is empty", () => {
    const next = openPinned(createEmptyCanvas(), SPEC_A);
    const pane = rootPane(next);
    expect(pane.tabInstanceIds).toHaveLength(1);
    expect(paneTabRefs(next, pane)[0]).toEqual(SPEC_A);
    expect(pane.activeTabId).toBe(SPEC_A.instanceId);
    expect(next.activePaneId).toBe(pane.id);
    expectCanvasInvariants(next);
  });

  it("appends to active pane as permanent tab", () => {
    const seeded = openPinned(createEmptyCanvas(), SPEC_A);
    const next = openPinned(seeded, SPEC_B);
    const pane = rootPane(next);
    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(pane.previewTabId).toBeNull();
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_B.id, SPEC_A.id]);
    expectCanvasInvariants(next);
  });

  it("fills an active blank 'New tab' in place instead of stacking beside it", () => {
    // Repro for the terminal-agent "phantom New tab": a fresh epic seeds a
    // blank "New tab" placeholder (EmptyEpicBlankRoot) while the agent tile is
    // still loading; when the agent tile then opens via `openTile`, it must
    // REPLACE the active blank rather than append a second tab - matching
    // `openTileInPane`'s fill-in-place semantics (browser new-tab behavior).
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;
    state = openBlankTabInPane(state, paneId);
    expect(rootPane(state).tabInstanceIds).toHaveLength(2);
    expect(isBlankTileRef(paneTabRefs(state, rootPane(state))[1])).toBe(true);

    state = openPinned(state, SPEC_B);
    const pane = rootPane(state);

    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(paneTabIds(state, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(isBlankTileRef(paneTabRefs(state, pane)[1])).toBe(false);
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expectCanvasInvariants(state);
  });

  it("dedupes by focusing existing tab", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const beforeId = rootPane(state).id;
    const next = openPinned(state, SPEC_A);
    const pane = rootPane(next);
    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(pane.activeTabId).toBe(SPEC_A.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(pane.id).toBe(beforeId);
  });

  it("records an existing tab focus when the tab was only synthetically active", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const sourcePaneId = rootPane(state).id;
    state = openTileInBackgroundTab(state, SPEC_B);
    state = openTileInBackgroundTab(state, SPEC_C);
    state = splitPaneAtEdge(state, sourcePaneId, "right", {
      kind: "node",
      node: CHAT_A,
    });
    const targetPaneId = state.activePaneId;
    if (targetPaneId === null) throw new Error("expected target pane");
    state = dropOnTabStrip(
      state,
      {
        kind: "tab",
        sourcePaneId,
        tabId: SPEC_A.instanceId,
        node: SPEC_A,
      },
      targetPaneId,
      1,
    );
    expect(paneById(state, sourcePaneId).activationHistory).toEqual([]);

    const next = openPinned(state, SPEC_B);
    const sourcePane = paneById(next, sourcePaneId);

    expect(next.activePaneId).toBe(sourcePaneId);
    expect(sourcePane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(next, sourcePane)).toEqual([SPEC_B.id]);
    expectCanvasInvariants(next);
  });

  it("records a same-pane focus when the tab was only synthetically active", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const sourcePaneId = rootPane(state).id;
    state = openTileInBackgroundTab(state, SPEC_B);
    state = openTileInBackgroundTab(state, SPEC_C);
    state = splitPaneAtEdge(state, sourcePaneId, "right", {
      kind: "node",
      node: CHAT_A,
    });
    const targetPaneId = state.activePaneId;
    if (targetPaneId === null) throw new Error("expected target pane");
    state = dropOnTabStrip(
      state,
      {
        kind: "tab",
        sourcePaneId,
        tabId: SPEC_A.instanceId,
        node: SPEC_A,
      },
      targetPaneId,
      1,
    );
    state = setActivePane(state, sourcePaneId);
    const beforeRoot = state.root;
    expect(paneById(state, sourcePaneId).activeTabId).toBe(SPEC_B.instanceId);
    expect(paneById(state, sourcePaneId).activationHistory).toEqual([]);

    const next = openPinned(state, SPEC_B);
    const sourcePane = paneById(next, sourcePaneId);

    expect(next.root).not.toBe(beforeRoot);
    expect(next.activePaneId).toBe(sourcePaneId);
    expect(sourcePane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(next, sourcePane)).toEqual([SPEC_B.id]);
    expectCanvasInvariants(next);
  });
});

describe("openTileInBackgroundTab", () => {
  it("appends a tab without changing the active tab or pane", () => {
    // SPEC_A is open and focused; registering SPEC_B in the background (as the
    // setup-terminal driver does) must not steal focus from SPEC_A.
    const seeded = openPinned(createEmptyCanvas(), SPEC_A);
    const next = openTileInBackgroundTab(seeded, SPEC_B);
    const pane = rootPane(next);
    expect(paneTabIds(next, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(pane.activeTabId).toBe(SPEC_A.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_A.id]);
    expect(next.activePaneId).toBe(pane.id);
    expectCanvasInvariants(next);
  });

  it("is idempotent for an already-open tile (no duplicate, focus untouched)", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B); // SPEC_B is now the active tab
    const next = openTileInBackgroundTab(state, SPEC_A);
    const pane = rootPane(next);
    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
  });

  it("is a no-op on an empty canvas (does not seed a focused tab)", () => {
    const next = openTileInBackgroundTab(createEmptyCanvas(), SPEC_A);
    expect(next.root).toBeNull();
  });
});

describe("openTile (preview open)", () => {
  it("opens as preview (italic) tab", () => {
    const next = openPreview(createEmptyCanvas(), SPEC_A);
    expect(rootPane(next).previewTabId).toBe(SPEC_A.instanceId);
  });

  it("replaces existing preview on next single-click, evicting the prior payload", () => {
    const a = openPreview(createEmptyCanvas(), SPEC_A);
    const b = openPreview(a, SPEC_B);
    const pane = rootPane(b);
    expect(pane.tabInstanceIds).toHaveLength(1);
    expect(pane.previewTabId).toBe(SPEC_B.instanceId);
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(b, pane)).toEqual([SPEC_B.id]);
    // The evicted preview's payload is gone too.
    expect(b.tilesByInstanceId[SPEC_A.instanceId]).toBeUndefined();
    expectCanvasInvariants(b);
  });

  it("promotePreview clears previewTabId without touching root", () => {
    const a = openPreview(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(a).id;
    const promoted = promotePreview(a, paneId);
    expect(rootPane(promoted).previewTabId).toBeNull();
  });
});

describe("git diff tiles", () => {
  it("opens and dedupes by semantic identity, not random tile id", () => {
    let state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    state = openPinned(state, GIT_FILE_A_DUP);
    const pane = rootPane(state);

    expect(pane.tabInstanceIds).toHaveLength(1);
    expect(paneTabIds(state, pane)[0]).toBe(GIT_FILE_A.id);
    expect(pane.activeTabId).toBe(GIT_FILE_A.instanceId);
  });

  it("replaces a git diff preview and drops the replaced tile-local state", () => {
    const wrappedPreview: GitDiffTileRef = {
      ...GIT_FILE_A,
      view: { collapsedFilePaths: ["src/a.ts"] },
    };
    const previewed = openPreview(createEmptyCanvas(), wrappedPreview);
    const replaced = openPreview(previewed, GIT_FILE_B);
    const pane = rootPane(replaced);

    expect(paneTabRefs(replaced, pane)).toEqual([GIT_FILE_B]);
    expect(pane.previewTabId).toBe(GIT_FILE_B.instanceId);
    expect(
      replaced.tilesByInstanceId[wrappedPreview.instanceId],
    ).toBeUndefined();
    expect(findPaneTabByContentId(replaced, wrappedPreview.id)).toBeNull();
  });

  it("moves an already-open semantic git diff tile on split drop", () => {
    let state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    const targetPaneId = rootPane(state).id;
    state = openPinned(state, SPEC_B);

    const next = splitPaneAtEdge(state, targetPaneId, "right", {
      kind: "node",
      node: GIT_FILE_A_DUP,
    });

    expect(next.root?.kind).toBe("group");
    const panes = collectPanes(next.root);
    expect(panes.flatMap((pane) => pane.tabInstanceIds)).toHaveLength(2);
    const moved = findPaneTabByContentId(next, GIT_FILE_A.id);
    expect(moved?.pane.id).not.toBe(targetPaneId);
    expect(moved?.ref.id).toBe(GIT_FILE_A.id);
  });

  it("updates tile-local view state and bundle collapsed paths without touching root", () => {
    let state = openPinned(createEmptyCanvas(), GIT_BUNDLE_CHANGES);
    const rootBefore = state.root;
    state = updateGitDiffTileView(state, GIT_BUNDLE_CHANGES.id, {
      collapsedFilePaths: ["src/manual.ts"],
    });
    state = toggleGitDiffBundleFileCollapsed(
      state,
      GIT_BUNDLE_CHANGES.id,
      "src/a.ts",
    );
    // The decoupling win: payload edits never recreate the tree.
    expect(state.root).toBe(rootBefore);
    const pane = rootPane(state);
    const tab = paneTabRefs(state, pane)[0];
    if (tab.type !== "git-diff") throw new Error("expected git diff");

    expect(tab.view).toEqual({
      collapsedFilePaths: ["src/manual.ts", "src/a.ts"],
    });
  });

  it("updates collapsed paths for snapshot cumulative bundles without touching root", () => {
    let state = openPinned(createEmptyCanvas(), SNAPSHOT_BUNDLE_CHANGES);
    const rootBefore = state.root;
    state = toggleSnapshotDiffBundleFileCollapsed(
      state,
      SNAPSHOT_BUNDLE_CHANGES.id,
      "src/a.ts",
    );
    expect(state.root).toBe(rootBefore);
    const pane = rootPane(state);
    const tab = paneTabRefs(state, pane)[0];
    if (tab.type !== "snapshot-diff") throw new Error("expected snapshot diff");

    expect(tab.view.collapsedFilePaths).toEqual(["src/a.ts"]);
  });
});

describe("closeTab cascade", () => {
  it("falls back to the most recently activated surviving tab, not the strip neighbor", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    state = openPinned(state, SPEC_C);
    const paneId = rootPane(state).id;
    state = setActiveTab(state, paneId, SPEC_A.instanceId);

    const next = closeTab(state, paneId, SPEC_A.instanceId);
    const pane = rootPane(next);

    expect(pane.activeTabId).toBe(SPEC_C.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_C.id, SPEC_B.id]);
    expectCanvasInvariants(next);
  });

  it("repeated active closes walk the activation stack without recording synthetic fallback", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    state = openPinned(state, SPEC_C);
    const paneId = rootPane(state).id;
    state = setActiveTab(state, paneId, SPEC_A.instanceId);

    state = closeTab(state, paneId, SPEC_A.instanceId);
    state = closeTab(state, paneId, SPEC_C.instanceId);
    const pane = rootPane(state);

    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(state, pane)).toEqual([SPEC_B.id]);
    expectCanvasInvariants(state);
  });

  it("prunes a non-active close without changing the active tab", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    state = openPinned(state, SPEC_C);
    const paneId = rootPane(state).id;
    state = setActiveTab(state, paneId, SPEC_A.instanceId);

    const next = closeTab(state, paneId, SPEC_B.instanceId);
    const pane = rootPane(next);

    expect(pane.activeTabId).toBe(SPEC_A.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_A.id, SPEC_C.id]);
    expectCanvasInvariants(next);
  });

  it("removes a non-last tab without collapsing the pane", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;
    const next = closeTab(state, paneId, SPEC_A.instanceId);
    const pane = rootPane(next);
    expect(pane.tabInstanceIds).toHaveLength(1);
    expect(paneTabIds(next, pane)[0]).toBe(SPEC_B.id);
    expect(next.tilesByInstanceId[SPEC_A.instanceId]).toBeUndefined();
    expectCanvasInvariants(next);
  });

  it("preserves the root pane as empty when last tab closes at root", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;
    const next = closeTab(state, paneId, SPEC_A.instanceId);
    const pane = rootPane(next);
    expect(pane.tabInstanceIds).toHaveLength(0);
    expect(pane.activationHistory).toEqual([]);
    expect(next.activePaneId).toBe(pane.id);
    expectCanvasInvariants(next);
  });

  it("collapses non-root pane when its last tab closes; sibling absorbs into root pane", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    rootGroup(state);
    if (state.activePaneId === null) throw new Error("expected active");
    const next = closeTab(state, state.activePaneId, SPEC_B.instanceId);
    // Single surviving child dissolves the group back to a bare pane.
    const pane = rootPane(next);
    expect(paneTabIds(next, pane)[0]).toBe(SPEC_A.id);
    expectCanvasInvariants(next);
  });
});

describe("close-family activation history", () => {
  it("closeOtherTabs records the kept context target", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    state = openPinned(state, SPEC_C);
    const paneId = rootPane(state).id;
    state = setActiveTab(state, paneId, SPEC_A.instanceId);

    const next = closeOtherTabs(state, paneId, SPEC_B.instanceId);
    const pane = rootPane(next);

    expect(paneTabIds(next, pane)).toEqual([SPEC_B.id]);
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_B.id]);
    expectCanvasInvariants(next);
  });

  it("closeRightTabs prunes removed ids without recording when the active tab is kept", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    state = openPinned(state, SPEC_C);
    const paneId = rootPane(state).id;
    state = setActiveTab(state, paneId, SPEC_A.instanceId);

    const next = closeRightTabs(state, paneId, SPEC_B.instanceId);
    const pane = rootPane(next);

    expect(paneTabIds(next, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(pane.activeTabId).toBe(SPEC_A.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expectCanvasInvariants(next);
  });

  it("closeRightTabs records the context target when the active tab is removed", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    state = openPinned(state, SPEC_C);
    const paneId = rootPane(state).id;
    state = setActiveTab(state, paneId, SPEC_A.instanceId);
    state = setActiveTab(state, paneId, SPEC_C.instanceId);

    const next = closeRightTabs(state, paneId, SPEC_B.instanceId);
    const pane = rootPane(next);

    expect(paneTabIds(next, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(pane.activeTabId).toBe(SPEC_B.instanceId);
    expect(activationContentIds(next, pane)).toEqual([SPEC_B.id, SPEC_A.id]);
    expectCanvasInvariants(next);
  });

  it("closeAllTabs leaves a root drop pane with empty activation history", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;

    const next = closeAllTabs(state, paneId);
    const pane = rootPane(next);

    expect(pane.tabInstanceIds).toEqual([]);
    expect(pane.activeTabId).toBeNull();
    expect(pane.activationHistory).toEqual([]);
    expectCanvasInvariants(next);
  });

  it("closePane replaces the root pane with empty activation history", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;

    const next = closePane(state, paneId);
    const pane = rootPane(next);

    expect(pane.tabInstanceIds).toEqual([]);
    expect(pane.activeTabId).toBeNull();
    expect(pane.activationHistory).toEqual([]);
    expectCanvasInvariants(next);
  });
});

describe("splitPaneAtEdge", () => {
  it("wraps the target pane in a fresh cross-direction group with the dragged node", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;
    const next = splitPaneAtEdge(state, paneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const group = rootGroup(next);
    expect(group.direction).toBe("horizontal");
    // Wrapping a bare pane uses even [0.5, 0.5] sizes.
    expect(next.sizesByGroupId[group.id]).toEqual([0.5, 0.5]);
    const located = findPaneTabByContentId(next, SPEC_B.id);
    expect(located).not.toBeNull();
    expect(next.activePaneId).toBe(located?.pane.id);
    expectCanvasInvariants(next);
  });

  it("flattens a same-direction split into the parent group (N-ary, no nesting)", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    // First split makes a 2-child horizontal group.
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const group = rootGroup(state);
    expect(group.children).toHaveLength(2);

    // A second horizontal split of the original pane flattens into the same
    // group rather than nesting a new binary split.
    const next = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_C,
    });
    const flat = rootGroup(next);
    expect(flat.direction).toBe("horizontal");
    expect(flat.children).toHaveLength(3);
    expect(flat.children.every((child) => child.kind === "pane")).toBe(true);
    expect(next.sizesByGroupId[flat.id]).toHaveLength(3);
    expectCanvasInvariants(next);
  });

  it("moves an already-open sidebar node instead of only focusing it", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;
    const next = splitPaneAtEdge(state, paneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    rootGroup(next);
    const moved = findPaneTabByContentId(next, SPEC_B.id);
    const original = findPaneById(next.root, paneId);
    expect(moved?.pane.id).not.toBe(paneId);
    expect(original === null ? null : paneTabIds(next, original)).toEqual([
      SPEC_A.id,
    ]);
    if (original === null) throw new Error("expected original pane");
    expect(activationContentIds(next, original)).toEqual([SPEC_A.id]);
    const movedHistory =
      moved === null ? null : activationContentIds(next, moved.pane);
    expect(movedHistory).toEqual([SPEC_B.id]);
    expect(next.activePaneId).toBe(moved?.pane.id);
    expectCanvasInvariants(next);
  });

  it("prunes split-source history and leaves source fallback unrecorded", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const sourcePaneId = rootPane(state).id;
    state = openTileInBackgroundTab(state, SPEC_B);
    state = openTileInBackgroundTab(state, SPEC_C);

    const next = splitPaneAtEdge(state, sourcePaneId, "right", {
      kind: "tab",
      sourcePaneId,
      tabId: SPEC_A.instanceId,
      node: SPEC_A,
    });
    const sourcePane = paneById(next, sourcePaneId);
    const moved = findPaneTabByContentId(next, SPEC_A.id);

    expect(sourcePane.activeTabId).toBe(SPEC_B.instanceId);
    expect(sourcePane.activationHistory).toEqual([]);
    expect(moved?.pane.id).not.toBe(sourcePaneId);
    const movedHistory =
      moved === null ? null : activationContentIds(next, moved.pane);
    expect(movedHistory).toEqual([SPEC_A.id]);
    expectCanvasInvariants(next);
  });

  it("collapses the source pane when moving an already-open sidebar node into a split", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const targetPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, targetPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const sourcePaneId = state.activePaneId;
    if (sourcePaneId === null) throw new Error("expected source pane");
    const next = splitPaneAtEdge(state, targetPaneId, "bottom", {
      kind: "node",
      node: SPEC_B,
    });
    expect(findPaneById(next.root, sourcePaneId)).toBeNull();
    expect(
      collectPanes(next.root).flatMap((pane) => pane.tabInstanceIds),
    ).toHaveLength(2);
    expect(findPaneTabByContentId(next, SPEC_B.id)).not.toBeNull();
    expectCanvasInvariants(next);
  });

  it("does not split a sole tab onto its own pane edge", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;
    const next = splitPaneAtEdge(state, paneId, "right", {
      kind: "node",
      node: SPEC_A,
    });
    expect(next).toBe(state);
  });

  it("rejects an edge split that would exceed MAX_TREE_DEPTH (no-op)", () => {
    // Build alternating cross-direction wraps to reach the depth cap. A bare
    // pane is depth 1; each cross-direction wrap adds one level.
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    // depth 2: horizontal group [paneA | paneB]
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const paneBId = state.activePaneId;
    if (paneBId === null) throw new Error("expected pane B");
    // depth 3: wrap paneB vertically -> [paneA | [paneB / paneC]]
    state = splitPaneAtEdge(state, paneBId, "bottom", {
      kind: "node",
      node: SPEC_C,
    });
    const paneCId = state.activePaneId;
    if (paneCId === null) throw new Error("expected pane C");
    expect(getTreeDepthOf(state)).toBe(3);
    // depth 4: wrap paneC horizontally -> still within the cap.
    const SPEC_D: EpicNodeRef = {
      id: "art-d",
      instanceId: "inst-d",
      type: "spec",
      name: "Spec D",
      hostId: TEST_HOST_ID,
    };
    state = splitPaneAtEdge(state, paneCId, "right", {
      kind: "node",
      node: SPEC_D,
    });
    expect(getTreeDepthOf(state)).toBe(4);
    const paneDId = state.activePaneId;
    if (paneDId === null) throw new Error("expected pane D");

    // A cross-direction wrap of paneD would make depth 5 -> rejected.
    const SPEC_E: EpicNodeRef = {
      id: "art-e",
      instanceId: "inst-e",
      type: "spec",
      name: "Spec E",
      hostId: TEST_HOST_ID,
    };
    const rejected = splitPaneAtEdge(state, paneDId, "bottom", {
      kind: "node",
      node: SPEC_E,
    });
    expect(rejected).toBe(state);
  });
});

describe("dropOnTabStrip", () => {
  it("moves an already-open sidebar node into the target strip", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const targetPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, targetPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const next = dropOnTabStrip(
      state,
      { kind: "node", node: SPEC_B },
      targetPaneId,
      0,
    );
    const targetPane = findPaneById(next.root, targetPaneId);
    expect(targetPane === null ? null : paneTabIds(next, targetPane)).toEqual([
      SPEC_B.id,
      SPEC_A.id,
    ]);
    expect(findPaneTabByContentId(next, SPEC_B.id)?.index).toBe(0);
    expect(next.activePaneId).toBe(targetPaneId);
    expectCanvasInvariants(next);
  });

  it("prunes cross-pane source history and leaves source fallback unrecorded", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const sourcePaneId = rootPane(state).id;
    state = openTileInBackgroundTab(state, SPEC_B);
    state = openTileInBackgroundTab(state, SPEC_C);
    state = splitPaneAtEdge(state, sourcePaneId, "right", {
      kind: "node",
      node: CHAT_A,
    });
    const targetPaneId = state.activePaneId;
    if (targetPaneId === null) throw new Error("expected target pane");

    const next = dropOnTabStrip(
      state,
      {
        kind: "tab",
        sourcePaneId,
        tabId: SPEC_A.instanceId,
        node: SPEC_A,
      },
      targetPaneId,
      1,
    );
    const sourcePane = paneById(next, sourcePaneId);
    const targetPane = paneById(next, targetPaneId);

    expect(sourcePane.activeTabId).toBe(SPEC_B.instanceId);
    expect(sourcePane.activationHistory).toEqual([]);
    expect(activationContentIds(next, targetPane)[0]).toBe(SPEC_A.id);
    expect(next.activePaneId).toBe(targetPaneId);
    expectCanvasInvariants(next);
  });

  it("reorders an already-open sidebar node inside the target strip", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;
    const next = dropOnTabStrip(
      state,
      { kind: "node", node: SPEC_A },
      paneId,
      2,
    );
    const pane = findPaneById(next.root, paneId);
    expect(pane === null ? null : paneTabIds(next, pane)).toEqual([
      SPEC_B.id,
      SPEC_A.id,
    ]);
    expect(next.activePaneId).toBe(paneId);
  });
});

describe("splitPaneEmpty", () => {
  it("places an empty placeholder pane on the trailing side", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_C);
    const paneId = rootPane(state).id;
    const next = splitPaneEmpty(state, paneId, "horizontal");
    const group = rootGroup(next);
    const trailing = asPane(group.children[1]);
    expect(trailing.tabInstanceIds).toHaveLength(0);
    expect(next.activePaneId).toBe(trailing.id);
    expectCanvasInvariants(next);
  });
});

describe("resizeSplit", () => {
  it("writes only sizesByGroupId, leaving root reference unchanged", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const group = rootGroup(state);
    const rootBefore = state.root;

    const next = resizeSplit(state, group.id, [0.7, 0.3]);
    // A resize must never recreate the tree object.
    expect(next.root).toBe(rootBefore);
    expect(next.sizesByGroupId[group.id]).toEqual([0.7, 0.3]);
  });

  it("clamps below-floor fractions via clampNormalizedSizes", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const group = rootGroup(state);
    const next = resizeSplit(state, group.id, [0.02, 0.98]);
    const sizes = next.sizesByGroupId[group.id];
    expect(sizes?.[0]).toBeCloseTo(0.1, 10);
    expect(sizes?.[1]).toBeCloseTo(0.9, 10);
  });

  it("is a no-op when the clamped sizes match the stored sizes", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const group = rootGroup(state);
    state = resizeSplit(state, group.id, [0.7, 0.3]);
    expect(resizeSplit(state, group.id, [0.7, 0.3])).toBe(state);
  });
});

describe("setActiveTab", () => {
  it("flips the pane's active tab and focuses the pane globally", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;
    const next = setActiveTab(state, paneId, SPEC_A.instanceId);
    const pane = findPaneById(next.root, paneId);
    expect(pane?.activeTabId).toBe(SPEC_A.instanceId);
    if (pane === null) throw new Error("expected pane");
    expect(activationContentIds(next, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    expect(next.activePaneId).toBe(paneId);
  });
});

describe("setActivePane", () => {
  it("focuses a pane without recording a tab activation", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    const before = collectPanes(state.root).map((pane) =>
      activationContentIds(state, pane),
    );

    const next = setActivePane(state, firstPaneId);

    expect(next.activePaneId).toBe(firstPaneId);
    expect(
      collectPanes(next.root).map((pane) => activationContentIds(next, pane)),
    ).toEqual(before);
    expectCanvasInvariants(next);
  });
});

describe("cloneEpicCanvasState", () => {
  it("preserves content ids but mints fresh pane/group and instance ids", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const firstPaneId = rootPane(state).id;
    state = openPreview(state, SPEC_B);
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: SPEC_C,
    });

    const cloned = cloneEpicCanvasState(state);

    expect(cloned).not.toBe(state);
    expect(cloned.root).not.toBe(state.root);
    // Fresh pane ids.
    expect(collectPanes(cloned.root).map((pane) => pane.id)).not.toEqual(
      collectPanes(state.root).map((pane) => pane.id),
    );
    // Fresh tab instanceIds.
    expect(Object.keys(cloned.tilesByInstanceId).toSorted()).not.toEqual(
      Object.keys(state.tilesByInstanceId).toSorted(),
    );
    // Content ids preserved, in pane order.
    expect(
      collectPanes(cloned.root).flatMap((pane) => paneTabIds(cloned, pane)),
    ).toEqual(
      collectPanes(state.root).flatMap((pane) => paneTabIds(state, pane)),
    );
    expect(
      collectPanes(cloned.root).map((pane) =>
        pane.activationHistory.map(
          (instanceId) => cloned.tilesByInstanceId[instanceId]?.id,
        ),
      ),
    ).toEqual(
      collectPanes(state.root).map((pane) =>
        pane.activationHistory.map(
          (instanceId) => state.tilesByInstanceId[instanceId]?.id,
        ),
      ),
    );
    expect(
      collectPanes(cloned.root).flatMap((pane) => [...pane.activationHistory]),
    ).not.toEqual(
      collectPanes(state.root).flatMap((pane) => [...pane.activationHistory]),
    );
    // activePaneId remapped (not preserved, not null).
    expect(cloned.activePaneId).not.toBe(state.activePaneId);
    expect(cloned.activePaneId).not.toBeNull();
    expect(findPaneById(cloned.root, cloned.activePaneId ?? "")).not.toBeNull();
    expectCanvasInvariants(cloned);
  });
});

describe("instanceId / content-id decoupling", () => {
  it("dedup collapses two opens of one content id even with distinct instanceIds", () => {
    const firstInstance: EpicNodeRef = { ...SPEC_A, instanceId: "inst-1" };
    const secondInstance: EpicNodeRef = { ...SPEC_A, instanceId: "inst-2" };
    let state = openPinned(createEmptyCanvas(), firstInstance);
    state = openPinned(state, secondInstance);
    const pane = rootPane(state);

    // Single-open is keyed on content id: the second open focuses the
    // existing tab rather than appending a second instance.
    expect(pane.tabInstanceIds).toHaveLength(1);
    expect(pane.tabInstanceIds[0]).toBe("inst-1");
    expect(pane.activeTabId).toBe("inst-1");
  });

  it("setActiveTab resolves by instanceId; content id is a no-op", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;

    // Passing the content id matches no tab instance -> unchanged state.
    expect(setActiveTab(state, paneId, SPEC_A.id)).toBe(state);

    const next = setActiveTab(state, paneId, SPEC_A.instanceId);
    expect(findPaneById(next.root, paneId)?.activeTabId).toBe(
      SPEC_A.instanceId,
    );
  });

  it("closeTab resolves by instanceId; content id is a no-op", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_B);
    const paneId = rootPane(state).id;

    // Content id never matches a tab instance -> no tab is removed.
    expect(closeTab(state, paneId, SPEC_B.id)).toBe(state);

    const next = closeTab(state, paneId, SPEC_B.instanceId);
    const pane = findPaneById(next.root, paneId);
    expect(pane === null ? null : paneTabIds(next, pane)).toEqual([SPEC_A.id]);
  });

  it("preview selection tracks instanceId while rename stays keyed on content id", () => {
    const previewed = openPreview(createEmptyCanvas(), SPEC_A);
    expect(rootPane(previewed).previewTabId).toBe(SPEC_A.instanceId);
    const rootBefore = previewed.root;

    // Rename matches by content id and updates the open tab in place,
    // touching only tilesByInstanceId.
    const renamed = renameArtifact(previewed, SPEC_A.id, "Renamed Spec");
    expect(renamed.root).toBe(rootBefore);
    const pane = rootPane(renamed);
    const tab = paneTabRefs(renamed, pane)[0];
    expect(tab.name).toBe("Renamed Spec");
    expect(tab.instanceId).toBe(SPEC_A.instanceId);
    expect(pane.previewTabId).toBe(SPEC_A.instanceId);
  });

  it("marks a renamed terminal tab as manually titled", () => {
    const terminal: EpicCanvasTileRef = {
      id: "terminal-1",
      instanceId: "inst-terminal-1",
      type: "terminal",
      name: "New Terminal",
      titleSource: "default",
      hostId: TEST_HOST_ID,
      cwd: "/repo",
    };
    const previewed = openPreview(createEmptyCanvas(), terminal);

    const renamed = renameArtifact(previewed, terminal.id, "Custom shell");
    const tab = paneTabRefs(renamed, rootPane(renamed))[0];
    expect(tab).toMatchObject({
      name: "Custom shell",
      titleSource: "manual",
    });
  });
});

describe("openTileInPane (non-dedup, target-scoped open)", () => {
  it("opens a SECOND instance of already-open content into the target pane", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;

    state = openTileInPane(state, paneId, SPEC_A);
    const pane = rootPane(state);

    // Same content id appears twice; the two tabs differ only by instanceId.
    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(paneTabIds(state, pane)).toEqual([SPEC_A.id, SPEC_A.id]);
    const [first, second] = pane.tabInstanceIds;
    expect(first).not.toBe(second);
    // The freshly minted instance is active, in the target pane.
    expect(pane.activeTabId).toBe(second);
    expect(state.activePaneId).toBe(paneId);
    expectCanvasInvariants(state);
  });

  it("leaves pinned-open dedup unchanged (focus-if-open)", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    state = openPinned(state, SPEC_A);
    expect(rootPane(state).tabInstanceIds).toHaveLength(1);
  });

  it("honors the explicit target pane even when it is not the active pane", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const targetPaneId = rootPane(state).id;
    // Split off a second pane; the new (sibling) pane becomes active.
    state = splitPaneAtEdge(state, targetPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    expect(state.activePaneId).not.toBe(targetPaneId);

    // Open into the NON-active original pane.
    state = openTileInPane(state, targetPaneId, SPEC_C);

    const target = findPaneById(state.root, targetPaneId);
    expect(target === null ? null : paneTabIds(state, target)).toEqual([
      SPEC_A.id,
      SPEC_C.id,
    ]);
    expect(target?.activeTabId).toBe(target?.tabInstanceIds[1]);
    // The target pane becomes active after the open.
    expect(state.activePaneId).toBe(targetPaneId);
  });

  it("is a no-op when the target pane does not exist", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    expect(openTileInPane(state, "missing-pane", SPEC_B)).toBe(state);
  });
});

describe("openBlankTabInPane", () => {
  it("appends a blank, active 'New tab' to a populated pane", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;

    state = openBlankTabInPane(state, paneId);
    const pane = rootPane(state);

    expect(pane.tabInstanceIds).toHaveLength(2);
    const blank = paneTabRefs(state, pane)[1];
    expect(isBlankTileRef(blank)).toBe(true);
    expect(blank.name).toBe("New tab");
    expect(pane.activeTabId).toBe(blank.instanceId);
    expect(activationContentIds(state, pane)).toEqual([blank.id, SPEC_A.id]);
    expect(state.activePaneId).toBe(paneId);
    expectCanvasInvariants(state);
  });

  it("reuses the active blank instead of stacking (repeated invocation)", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;

    state = openBlankTabInPane(state, paneId);
    const firstBlankId = rootPane(state).activeTabId;

    // Second invocation while the active tab is already blank just focuses it.
    state = openBlankTabInPane(state, paneId);
    const pane = rootPane(state);
    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(pane.activeTabId).toBe(firstBlankId);
  });

  it("is a no-op when the target pane does not exist", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    expect(openBlankTabInPane(state, "missing-pane")).toBe(state);
  });
});

describe("openTileInPane fill-in-place (blank replacement)", () => {
  it("replaces an active blank tab in place rather than appending", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;
    state = openBlankTabInPane(state, paneId);
    expect(rootPane(state).tabInstanceIds).toHaveLength(2);
    const blankIndex = 1;

    // Picking content while the blank is active replaces it at the same index.
    state = openTileInPane(state, paneId, SPEC_B);
    const pane = rootPane(state);

    expect(pane.tabInstanceIds).toHaveLength(2);
    expect(paneTabIds(state, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
    const replaced = paneTabRefs(state, pane)[blankIndex];
    expect(isBlankTileRef(replaced)).toBe(false);
    expect(pane.activeTabId).toBe(replaced.instanceId);
    expect(activationContentIds(state, pane)).toEqual([SPEC_B.id, SPEC_A.id]);
    expectCanvasInvariants(state);
  });

  it("appends (does not replace) when the active tab is not blank", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const paneId = rootPane(state).id;

    state = openTileInPane(state, paneId, SPEC_B);
    const pane = rootPane(state);
    expect(paneTabIds(state, pane)).toEqual([SPEC_A.id, SPEC_B.id]);
  });
});

describe("findActiveGitFileDiffTile", () => {
  it("returns null for an empty canvas", () => {
    expect(findActiveGitFileDiffTile(createEmptyCanvas())).toBeNull();
  });

  it("returns the focused group's active file diff tile", () => {
    const state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    expect(findActiveGitFileDiffTile(state)?.id).toBe(GIT_FILE_A.id);
  });

  it("ignores a focused bundle diff tile", () => {
    const state = openPinned(createEmptyCanvas(), GIT_BUNDLE_CHANGES);
    expect(findActiveGitFileDiffTile(state)).toBeNull();
  });

  it("falls back to the unique other group's active file diff tile", () => {
    let state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    const gitPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, gitPaneId, "right", {
      kind: "node",
      node: SPEC_A,
    });
    expect(findActiveGitFileDiffTile(state)?.id).toBe(GIT_FILE_A.id);
  });

  it("returns null when two unfocused groups both show file diff tiles", () => {
    let state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    const firstPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, firstPaneId, "right", {
      kind: "node",
      node: GIT_FILE_B,
    });
    const secondPaneId = state.activePaneId;
    if (secondPaneId === null) throw new Error("expected active pane");
    state = splitPaneAtEdge(state, secondPaneId, "right", {
      kind: "node",
      node: SPEC_A,
    });
    expect(findActiveGitFileDiffTile(state)).toBeNull();
  });

  it("prefers the focused group over other groups' file diff tiles", () => {
    let state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    const gitPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, gitPaneId, "right", {
      kind: "node",
      node: GIT_FILE_B,
    });
    expect(findActiveGitFileDiffTile(state)?.id).toBe(GIT_FILE_B.id);
  });

  it("stays on the last git group when focus moves to a non-git tab elsewhere", () => {
    let state = openPinned(createEmptyCanvas(), GIT_FILE_A);
    const gitGroupId = (state.root as { id: string }).id;
    state = splitPaneAtEdge(state, gitGroupId, "right", {
      kind: "node",
      node: SPEC_A,
    });
    expect(state.activePaneId).not.toBe(gitGroupId);
    expect(findActiveGitFileDiffTile(state)?.id).toBe(GIT_FILE_A.id);
  });
});

describe("openTile no-op short-circuits (same reference)", () => {
  it("returns the same reference for a pinned re-open of the active tab in the focused pane", () => {
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    expect(openTile(state, SPEC_A, false)).toBe(state);
  });

  it("returns the same reference for a preview open of an already-active pinned tab in the focused pane", () => {
    // Previously `openTilePreview` rebuilt an identical state object here;
    // the unified `openTile` short-circuits to the same reference.
    const state = openPinned(createEmptyCanvas(), SPEC_A);
    expect(openTile(state, SPEC_A, true)).toBe(state);
  });

  it("returns the same reference for a preview re-open of the active preview tab in the focused pane", () => {
    const state = openPreview(createEmptyCanvas(), SPEC_A);
    expect(openTile(state, SPEC_A, true)).toBe(state);
  });

  it("is NOT a no-op when a pinned open promotes the active preview tab", () => {
    // Promote-on-pin must still produce a new state with the preview cleared.
    const state = openPreview(createEmptyCanvas(), SPEC_A);
    const next = openTile(state, SPEC_A, false);
    expect(next).not.toBe(state);
    expect(rootPane(next).previewTabId).toBeNull();
    expect(rootPane(next).activeTabId).toBe(SPEC_A.instanceId);
    expectCanvasInvariants(next);
  });

  it("is NOT a no-op when the focused pane differs from the holding pane", () => {
    let state = openPinned(createEmptyCanvas(), SPEC_A);
    const holdingPaneId = rootPane(state).id;
    state = splitPaneAtEdge(state, holdingPaneId, "right", {
      kind: "node",
      node: SPEC_B,
    });
    expect(state.activePaneId).not.toBe(holdingPaneId);
    const next = openTile(state, SPEC_A, false);
    expect(next).not.toBe(state);
    expect(next.root).toBe(state.root);
    expect(next.activePaneId).toBe(holdingPaneId);
  });
});
