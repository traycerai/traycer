/**
 * Shared fixtures for the canvas store suites (`actions.test.ts`,
 * `store.test.ts`, `migrate-canvas.test.ts`, `tile-tree.test.ts`):
 * canonical tile refs, typed tree builders, and the ONE invariant checker
 * (`expectCanvasInvariants`) asserting the union of the tiles/tree/sizes/
 * active-pane invariants every action and every parse must uphold.
 */
import { expect } from "vitest";
import {
  makeGitBundleDiffTile,
  makeGitFileDiffTile,
} from "@/lib/git/git-diff-tile";
import { makeSnapshotCumulativeBundleDiffTile } from "@/lib/chat/snapshot-diff-tile";
import type {
  EpicCanvasState,
  EpicNodeRef,
  GitDiffTileRef,
  SnapshotDiffTileRef,
} from "@/stores/epics/canvas/types";
import type {
  SplitDirection,
  TileGroup,
  TileLayoutNode,
  TilePane,
} from "@/stores/epics/canvas/tile-tree";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { paneTabRefs } from "@/stores/epics/canvas/actions";

export const TEST_HOST_ID = "test-host";

export const SPEC_A: EpicNodeRef = {
  id: "art-a",
  instanceId: "inst-a",
  type: "spec",
  name: "Spec A",
  hostId: TEST_HOST_ID,
};
export const SPEC_B: EpicNodeRef = {
  id: "art-b",
  instanceId: "inst-b",
  type: "spec",
  name: "Spec B",
  hostId: TEST_HOST_ID,
};
export const SPEC_C: EpicNodeRef = {
  id: "art-c",
  instanceId: "inst-c",
  type: "spec",
  name: "Spec C",
  hostId: TEST_HOST_ID,
};
/** Chat-kind sibling of {@link SPEC_A} (distinct tile-schema serializer). */
export const CHAT_A: EpicNodeRef = {
  id: "chat-a",
  instanceId: "inst-chat-a",
  type: "chat",
  name: "Chat A",
  hostId: TEST_HOST_ID,
};
/** Ticket-kind sibling (third serializer flavor for migration coverage). */
export const TICKET_C: EpicNodeRef = {
  id: "ticket-c",
  instanceId: "inst-ticket-c",
  type: "ticket",
  name: "Ticket C",
  hostId: TEST_HOST_ID,
};

// Git diff tile ids are deterministic (host + payload), so two tiles
// for the same diff dedupe by plain id equality.
export const GIT_FILE_A: GitDiffTileRef = makeGitFileDiffTile({
  hostId: TEST_HOST_ID,
  runningDir: "/repo",
  filePath: "src/a.ts",
  stage: "unstaged",
  repositoryContext: null,
});
// Same diff as GIT_FILE_A - same deterministic id - but distinct
// tile-local view state, exercising "dedupe focuses the existing tab".
export const GIT_FILE_A_DUP: GitDiffTileRef = {
  ...GIT_FILE_A,
  view: { collapsedFilePaths: ["src/a.ts"] },
};
export const GIT_FILE_B: GitDiffTileRef = makeGitFileDiffTile({
  hostId: TEST_HOST_ID,
  runningDir: "/repo",
  filePath: "src/b.ts",
  stage: "unstaged",
  repositoryContext: null,
});
export const GIT_BUNDLE_CHANGES: GitDiffTileRef = makeGitBundleDiffTile({
  hostId: TEST_HOST_ID,
  runningDir: "/repo",
  bundleGroup: "changes",
  repositoryContext: null,
});
export const SNAPSHOT_BUNDLE_CHANGES: SnapshotDiffTileRef =
  makeSnapshotCumulativeBundleDiffTile({
    hostId: TEST_HOST_ID,
    chatId: "chat-1",
    filePaths: ["src/a.ts", "src/b.ts"],
  });

// ---------------------------------------------------------------------------
// Typed literal builders (no `any`, no casts)
// ---------------------------------------------------------------------------

export function pane(
  id: string,
  tabInstanceIds: ReadonlyArray<string>,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds,
    activeTabId: tabInstanceIds[0] ?? null,
    previewTabId: null,
    activationHistory: tabInstanceIds.length === 0 ? [] : [tabInstanceIds[0]],
  };
}

export function group(
  id: string,
  direction: SplitDirection,
  children: ReadonlyArray<TileLayoutNode>,
): TileGroup {
  return { kind: "group", id, direction, children };
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/** Narrow `root` to a pane, throwing on a group/null root. */
export function rootPane(state: EpicCanvasState): TilePane {
  if (state.root === null || state.root.kind !== "pane") {
    throw new Error("expected root pane");
  }
  return state.root;
}

/** Narrow `root` to a group, throwing on a pane/null root. */
export function rootGroup(state: EpicCanvasState): TileGroup {
  if (state.root === null || state.root.kind !== "group") {
    throw new Error("expected root group");
  }
  return state.root;
}

/** Narrow a layout node to a pane. */
export function asPane(node: TileLayoutNode | null): TilePane {
  if (node === null || node.kind !== "pane") {
    throw new Error("expected pane node");
  }
  return node;
}

/** Content ids of a pane's tabs, in strip order. */
export function paneTabIds(
  state: EpicCanvasState,
  target: TilePane,
): ReadonlyArray<string> {
  return paneTabRefs(state, target).map((ref) => ref.id);
}

/** All instanceIds reachable from the tree, in pane+strip order. */
export function reachableInstanceIds(
  state: EpicCanvasState,
): ReadonlyArray<string> {
  return collectPanes(state.root).flatMap((p) => [...p.tabInstanceIds]);
}

function allGroupIds(node: TileLayoutNode | null): ReadonlyArray<string> {
  if (node === null || node.kind === "pane") return [];
  return [node.id, ...node.children.flatMap(allGroupIds)];
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Assert the full canvas invariant set (every action output AND every parse
 * output must satisfy all of these):
 *
 * 1. Reachable instanceIds are unique across the tree.
 * 2. `tilesByInstanceId`'s key set exactly matches the reachable set
 *    (every tab has a payload, no orphan payloads).
 * 3. `sizesByGroupId` holds entries only for live group ids.
 * 4. `activePaneId` resolves to an existing pane (and is null only for the
 *    empty canvas).
 * 5. Pane activation histories contain unique live tab ids with matching
 *    payload entries.
 */
export function expectCanvasInvariants(state: EpicCanvasState): void {
  const reachable = reachableInstanceIds(state);
  expect(new Set(reachable).size).toBe(reachable.length);
  expect([...reachable].toSorted()).toEqual(
    Object.keys(state.tilesByInstanceId).toSorted(),
  );
  for (const [instanceId, ref] of Object.entries(state.tilesByInstanceId)) {
    expect(ref?.instanceId).toBe(instanceId);
  }
  const liveGroupIds = new Set(allGroupIds(state.root));
  for (const groupId of Object.keys(state.sizesByGroupId)) {
    expect(liveGroupIds.has(groupId)).toBe(true);
  }
  if (state.root === null) {
    expect(state.activePaneId).toBeNull();
    return;
  }
  const panes = collectPanes(state.root);
  expect(panes.map((p) => p.id)).toContain(state.activePaneId);
  for (const pane of panes) {
    expect(new Set(pane.activationHistory).size).toBe(
      pane.activationHistory.length,
    );
    for (const instanceId of pane.activationHistory) {
      expect(pane.tabInstanceIds).toContain(instanceId);
      expect(state.tilesByInstanceId[instanceId]?.instanceId).toBe(instanceId);
    }
  }
}
