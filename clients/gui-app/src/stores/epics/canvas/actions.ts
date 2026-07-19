/**
 * Pure actions over `EpicCanvasState` (the N-ary split tree + decoupled tile
 * payloads). Every action:
 *
 * - is immutable with structural sharing (untouched sibling subtrees keep
 *   reference identity),
 * - returns the SAME state reference for no-ops so the store can skip the
 *   write entirely,
 * - keeps `tilesByInstanceId` in lockstep with tree membership (every
 *   instanceId reachable from `root` has exactly one payload entry, and
 *   nothing else does),
 * - keeps `sizesByGroupId` pruned to live group ids.
 *
 * Vocabulary (see `tile-tree.ts`): a **pane** is the leaf tab group, a
 * **group** is a split container. Pane-addressed APIs take `paneId`;
 * only the sizes map (`resizeSplit`) addresses a group.
 *
 * Tab identity recap (see `types.ts`): structural ops key on a tab's
 * `instanceId`; dedup and rename key on the payload's content `id`.
 */
import { v4 as uuidv4 } from "uuid";
import type {
  EpicCanvasTileRef,
  EpicCanvasState,
  GitDiffTileRef,
  GitDiffTileViewState,
  TilesByInstanceId,
} from "./types";
import {
  isBlankTileRef,
  isGitDiffTileRef,
  isSnapshotDiffTileRef,
} from "./types";
import {
  activationHistoryEqual,
  pruneActivationHistory,
} from "./activation-history";
import type {
  EdgeDropPosition,
  SplitDirection,
  TileLayoutNode,
  TilePane,
} from "./tile-tree";
import {
  clampNormalizedSizes,
  collectPanes,
  findPaneById,
  firstPaneId,
  insertPaneAtEdge,
  removePaneFromTree,
  replacePane,
} from "./tile-tree";
import { createEmptyCanvas } from "./canvas-state";
import { makeBlankTileRef } from "./tile-schema/blank-tile";

// ---------------------------------------------------------------------------
// Pane / tile helpers
// ---------------------------------------------------------------------------

function createEmptyPane(): TilePane {
  return {
    kind: "pane",
    id: uuidv4(),
    tabInstanceIds: [],
    activeTabId: null,
    previewTabId: null,
    activationHistory: [],
  };
}

function createPaneWithTab(
  node: EpicCanvasTileRef,
  preview: boolean,
): TilePane {
  return {
    kind: "pane",
    id: uuidv4(),
    tabInstanceIds: [node.instanceId],
    activeTabId: node.instanceId,
    previewTabId: preview ? node.instanceId : null,
    activationHistory: [node.instanceId],
  };
}

function withTile(
  tiles: TilesByInstanceId,
  node: EpicCanvasTileRef,
): TilesByInstanceId {
  return { ...tiles, [node.instanceId]: node };
}

function withoutTiles(
  tiles: TilesByInstanceId,
  instanceIds: ReadonlyArray<string>,
): TilesByInstanceId {
  const present = instanceIds.filter((id) => Object.hasOwn(tiles, id));
  if (present.length === 0) return tiles;
  const next: Record<string, EpicCanvasTileRef | undefined> = { ...tiles };
  for (const id of present) delete next[id];
  return next;
}

/** A pane's tab payloads in strip order, skipping unresolvable entries. */
export function paneTabRefs(
  state: EpicCanvasState,
  pane: TilePane,
): ReadonlyArray<EpicCanvasTileRef> {
  return pane.tabInstanceIds.flatMap((instanceId) => {
    const ref = state.tilesByInstanceId[instanceId];
    return ref === undefined ? [] : [ref];
  });
}

function prunePaneActivationHistory(
  pane: TilePane,
  tabInstanceIds: ReadonlyArray<string>,
): TilePane {
  const activationHistory = pruneActivationHistory(
    pane.activationHistory,
    tabInstanceIds,
  );
  return activationHistoryEqual(pane.activationHistory, activationHistory)
    ? pane
    : { ...pane, activationHistory };
}

function recordPaneActivation(pane: TilePane, tabId: string): TilePane {
  if (!pane.tabInstanceIds.includes(tabId)) return pane;
  const pruned = pruneActivationHistory(
    pane.activationHistory,
    pane.tabInstanceIds,
  );
  const activationHistory = [
    tabId,
    ...pruned.filter((instanceId) => instanceId !== tabId),
  ];
  if (
    pane.activeTabId === tabId &&
    activationHistoryEqual(pane.activationHistory, activationHistory)
  ) {
    return pane;
  }
  return { ...pane, activeTabId: tabId, activationHistory };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function activeGitFileDiffTileOfPane(
  state: EpicCanvasState,
  pane: TilePane,
): GitDiffTileRef | null {
  if (pane.activeTabId === null) return null;
  const activeTab = paneTabRefs(state, pane).find(
    (tab) => tab.instanceId === pane.activeTabId,
  );
  if (activeTab === undefined) return null;
  if (!isGitDiffTileRef(activeTab)) return null;
  return activeTab.diff.kind === "file" ? activeTab : null;
}

/**
 * The single-file git-diff tile the user is "looking at" on the canvas:
 * the focused pane's active tab when it is a file diff tile, otherwise
 * the unique pane whose active tab is a file diff tile. Two or more
 * candidate panes are ambiguous and resolve to null - the git panel
 * shows no active row rather than guessing.
 */
export function findActiveGitFileDiffTile(
  canvas: EpicCanvasState,
): GitDiffTileRef | null {
  const focusedPane =
    canvas.activePaneId === null
      ? null
      : findPaneById(canvas.root, canvas.activePaneId);
  const fromFocused =
    focusedPane === null
      ? null
      : activeGitFileDiffTileOfPane(canvas, focusedPane);
  if (fromFocused !== null) return fromFocused;

  const candidates = collectPanes(canvas.root)
    .map((pane) => activeGitFileDiffTileOfPane(canvas, pane))
    .filter((tile): tile is GitDiffTileRef => tile !== null);
  return candidates.length === 1 ? candidates[0] : null;
}

export interface PaneTabLocation {
  readonly pane: TilePane;
  readonly index: number;
  readonly instanceId: string;
  readonly ref: EpicCanvasTileRef;
}

/**
 * Locate an open tab by content id. Every tile kind carries a deterministic
 * content `id` (artifact uuid, workspace-file path hash, git-diff payload
 * hash), so dedup is plain id equality across all kinds. Used by global
 * dedup - opening content already present anywhere focuses that tab instead
 * of cloning.
 */
export function findPaneTabByContentId(
  state: EpicCanvasState,
  contentId: string,
): PaneTabLocation | null {
  for (const pane of collectPanes(state.root)) {
    for (let index = 0; index < pane.tabInstanceIds.length; index += 1) {
      const instanceId = pane.tabInstanceIds[index];
      const ref = state.tilesByInstanceId[instanceId];
      if (ref !== undefined && ref.id === contentId) {
        return { pane, index, instanceId, ref };
      }
    }
  }
  return null;
}

function activePaneOrFirst(state: EpicCanvasState): TilePane | null {
  if (state.root === null) return null;
  const active =
    state.activePaneId === null
      ? null
      : findPaneById(state.root, state.activePaneId);
  if (active !== null) return active;
  return findPaneById(state.root, firstPaneId(state.root));
}

// ---------------------------------------------------------------------------
// Pane-local tab list edits
// ---------------------------------------------------------------------------

interface InsertTabResult {
  readonly pane: TilePane;
  /** Instance id of a preview tab evicted by a preview insert, if any. */
  readonly removedPreviewInstanceId: string | null;
}

/**
 * Insert `instanceId` into `pane` at `index`, becoming the active tab. If
 * `preview` is true the inserted tab also becomes the pane's preview tab,
 * evicting any existing preview tab entirely (the caller must GC its
 * payload).
 */
function insertTabInstance(
  pane: TilePane,
  instanceId: string,
  index: number,
  preview: boolean,
): InsertTabResult {
  const clamped = Math.max(0, Math.min(index, pane.tabInstanceIds.length));
  const evictPreview = preview && pane.previewTabId !== null;
  const removedPreviewInstanceId = evictPreview ? pane.previewTabId : null;
  const withoutOldPreview = evictPreview
    ? pane.tabInstanceIds.filter((id) => id !== pane.previewTabId)
    : pane.tabInstanceIds;
  const insertAt = preview
    ? Math.min(clamped, withoutOldPreview.length)
    : clamped;
  const tabInstanceIds = [
    ...withoutOldPreview.slice(0, insertAt),
    instanceId,
    ...withoutOldPreview.slice(insertAt),
  ];
  const paneWithMembership = {
    ...pane,
    tabInstanceIds,
    activeTabId: instanceId,
    previewTabId: preview ? instanceId : pane.previewTabId,
  };
  return {
    pane: prunePaneActivationHistory(paneWithMembership, tabInstanceIds),
    removedPreviewInstanceId,
  };
}

function selectSyntheticFallback(
  pane: TilePane,
  removedIndex: number,
): string | null {
  if (pane.activationHistory.length > 0) return pane.activationHistory[0];
  if (pane.tabInstanceIds.length === 0) return null;
  return pane.tabInstanceIds[
    Math.min(removedIndex, pane.tabInstanceIds.length - 1)
  ];
}

/**
 * Remove the tab at `index` and prune history only. If the removed tab was
 * active, the active tab is cleared; callers that need source/close fallback
 * must opt into `removeTabAtIndexWithSyntheticFallback`.
 */
function removeTabAtIndexPruneOnly(
  pane: TilePane,
  index: number,
): { readonly pane: TilePane; readonly removedInstanceId: string | null } {
  if (index < 0 || index >= pane.tabInstanceIds.length) {
    return { pane, removedInstanceId: null };
  }
  const removed = pane.tabInstanceIds[index];
  const tabInstanceIds = [
    ...pane.tabInstanceIds.slice(0, index),
    ...pane.tabInstanceIds.slice(index + 1),
  ];
  const activeTabId =
    pane.activeTabId !== null && tabInstanceIds.includes(pane.activeTabId)
      ? pane.activeTabId
      : null;
  const previewTabId = pane.previewTabId === removed ? null : pane.previewTabId;
  const paneWithMembership = {
    ...pane,
    tabInstanceIds,
    activeTabId,
    previewTabId,
  };
  return {
    pane: prunePaneActivationHistory(paneWithMembership, tabInstanceIds),
    removedInstanceId: removed,
  };
}

/**
 * Remove the tab at `index` and, only when that tab was active, choose the
 * replacement synthetically from pruned history first and position second.
 * The fallback is not recorded as a committed activation.
 */
function removeTabAtIndexWithSyntheticFallback(
  pane: TilePane,
  index: number,
): { readonly pane: TilePane; readonly removedInstanceId: string | null } {
  const removed = removeTabAtIndexPruneOnly(pane, index);
  if (
    removed.removedInstanceId === null ||
    pane.activeTabId !== removed.removedInstanceId
  ) {
    return removed;
  }
  const activeTabId = selectSyntheticFallback(removed.pane, index);
  return {
    ...removed,
    pane:
      removed.pane.activeTabId === activeTabId
        ? removed.pane
        : { ...removed.pane, activeTabId },
  };
}

/**
 * Resolve a pane's active tab and its index, mirroring the renderer's
 * fallback (`activeTabId === null` -> first tab). `null` for empty panes.
 */
function resolveActiveTabInstance(
  pane: TilePane,
): { readonly instanceId: string; readonly index: number } | null {
  if (pane.tabInstanceIds.length === 0) return null;
  const found =
    pane.activeTabId === null
      ? -1
      : pane.tabInstanceIds.indexOf(pane.activeTabId);
  const index = found === -1 ? 0 : found;
  return { instanceId: pane.tabInstanceIds[index], index };
}

// ---------------------------------------------------------------------------
// Seed / clone
// ---------------------------------------------------------------------------

function seedRootPane(
  node: EpicCanvasTileRef,
  preview: boolean,
): EpicCanvasState {
  const pane = createPaneWithTab(node, preview);
  return {
    root: pane,
    activePaneId: pane.id,
    tilesByInstanceId: { [node.instanceId]: node },
    sizesByGroupId: {},
  };
}

/** Canvas containing exactly one pane with one tab (tear-off, open-in-new-tab). */
export function createSingleTileCanvas(
  node: EpicCanvasTileRef,
): EpicCanvasState {
  return seedRootPane(node, false);
}

/**
 * Deep-clone a canvas with fresh pane/group ids AND fresh per-tab
 * `instanceId`s so cloned canvases never share a tab identity (content `id`
 * is preserved). `activePaneId` and `sizesByGroupId` are remapped through
 * the same id maps.
 */
export function cloneEpicCanvasState(state: EpicCanvasState): EpicCanvasState {
  if (state.root === null) return createEmptyCanvas();
  const paneIdMap = new Map<string, string>();
  const tiles: Record<string, EpicCanvasTileRef> = {};
  const sizes: Record<string, ReadonlyArray<number>> = {};

  function cloneNode(node: TileLayoutNode): TileLayoutNode {
    if (node.kind === "group") {
      const id = uuidv4();
      const stored = state.sizesByGroupId[node.id];
      if (stored !== undefined) sizes[id] = stored;
      return {
        kind: "group",
        id,
        direction: node.direction,
        children: node.children.map(cloneNode),
      };
    }
    const paneId = uuidv4();
    paneIdMap.set(node.id, paneId);
    const instanceIdMap = new Map<string, string>();
    const tabInstanceIds = node.tabInstanceIds.map((instanceId) => {
      const nextInstanceId = uuidv4();
      instanceIdMap.set(instanceId, nextInstanceId);
      const ref = state.tilesByInstanceId[instanceId];
      if (ref !== undefined) {
        tiles[nextInstanceId] = { ...ref, instanceId: nextInstanceId };
      }
      return nextInstanceId;
    });
    const remap = (instanceId: string | null): string | null =>
      instanceId === null ? null : (instanceIdMap.get(instanceId) ?? null);
    const activationHistory = node.activationHistory.flatMap((instanceId) => {
      const nextInstanceId = instanceIdMap.get(instanceId);
      return nextInstanceId === undefined ? [] : [nextInstanceId];
    });
    return {
      kind: "pane",
      id: paneId,
      tabInstanceIds,
      activeTabId: remap(node.activeTabId),
      previewTabId: remap(node.previewTabId),
      activationHistory,
    };
  }

  const root = cloneNode(state.root);
  return {
    root,
    activePaneId:
      state.activePaneId === null
        ? null
        : (paneIdMap.get(state.activePaneId) ?? null),
    tilesByInstanceId: tiles,
    sizesByGroupId: sizes,
  };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open a tile in the canvas. Global dedup: if the content is already open in
 * any pane, focus that tab. Otherwise insert into the active pane. Seeds a
 * root pane when the canvas is empty.
 *
 * `preview` controls the VS Code-style single-click semantics:
 *
 * - `preview: false` (permanent open): the new tab is a regular pinned tab.
 *   Re-opening a tab that is currently the pane's preview promotes it to
 *   permanent (clears `previewTabId`).
 * - `preview: true`: the new tab becomes the pane's preview tab, replacing
 *   (and GC-ing the payload of) any existing preview tab in the destination
 *   pane. Focusing an already-open tab never demotes it to preview.
 *
 * No-op (same reference) when the tab is already active in the already
 * focused pane and no preview promotion applies.
 */
export function openTile(
  state: EpicCanvasState,
  node: EpicCanvasTileRef,
  preview: boolean,
): EpicCanvasState {
  if (state.root === null) return seedRootPane(node, preview);
  const existing = findPaneTabByContentId(state, node.id);
  if (existing !== null) {
    const root = replacePane(state.root, existing.pane.id, (pane) => {
      const previewTabId =
        !preview && pane.previewTabId === existing.instanceId
          ? null
          : pane.previewTabId;
      const paneWithPreview =
        previewTabId === pane.previewTabId ? pane : { ...pane, previewTabId };
      return recordPaneActivation(paneWithPreview, existing.instanceId);
    });
    if (root === state.root && state.activePaneId === existing.pane.id) {
      return state;
    }
    return { ...state, root, activePaneId: existing.pane.id };
  }
  const target = activePaneOrFirst(state);
  if (target === null) return state;

  // Fill-in-place: a permanent open while the active tab is a blank "New tab"
  // replaces that blank at its index rather than stacking a second tab (browser
  // new-tab semantics; mirrors `openTileInPane`). Without this, opening content
  // over the placeholder blank an empty epic seeds - e.g. a terminal-agent tile
  // landing after `EmptyEpicBlankRoot` runs - leaves a phantom "New tab" beside
  // it. Preview opens keep appending: a hover-preview must not consume a blank.
  const active = preview ? null : resolveActiveTabInstance(target);
  const activeRef =
    active === null
      ? null
      : (state.tilesByInstanceId[active.instanceId] ?? null);
  if (active !== null && activeRef !== null && isBlankTileRef(activeRef)) {
    const tabInstanceIds = target.tabInstanceIds.map((id, index) =>
      index === active.index ? node.instanceId : id,
    );
    const root = replacePane(state.root, target.id, (pane) => {
      const nextPane = prunePaneActivationHistory(
        {
          ...pane,
          tabInstanceIds,
          activeTabId: node.instanceId,
          previewTabId:
            pane.previewTabId === active.instanceId ? null : pane.previewTabId,
        },
        tabInstanceIds,
      );
      return recordPaneActivation(nextPane, node.instanceId);
    });
    return {
      ...state,
      root,
      activePaneId: target.id,
      tilesByInstanceId: withTile(
        withoutTiles(state.tilesByInstanceId, [active.instanceId]),
        node,
      ),
    };
  }

  const inserted = insertTabInstance(
    target,
    node.instanceId,
    target.tabInstanceIds.length,
    preview,
  );
  const root = replacePane(state.root, target.id, () =>
    recordPaneActivation(inserted.pane, node.instanceId),
  );
  const tilesWithNode = withTile(state.tilesByInstanceId, node);
  return {
    ...state,
    root,
    activePaneId: target.id,
    tilesByInstanceId:
      inserted.removedPreviewInstanceId === null
        ? tilesWithNode
        : withoutTiles(tilesWithNode, [inserted.removedPreviewInstanceId]),
  };
}

/**
 * Register a tile as a tab in the active pane WITHOUT changing the active
 * tab/pane. Used to persist a server-created terminal (the worktree setup
 * terminal) as a real saved tab - so it survives a restart like a
 * user-opened terminal - without yanking the user off the chat they are
 * reading. Idempotent: if the tile is already open anywhere, it is left
 * untouched.
 */
export function openTileInBackgroundTab(
  state: EpicCanvasState,
  node: EpicCanvasTileRef,
): EpicCanvasState {
  if (state.root === null) return state;
  if (findPaneTabByContentId(state, node.id) !== null) return state;
  const target = activePaneOrFirst(state);
  if (target === null) return state;
  const root = replacePane(state.root, target.id, (pane) => ({
    ...pane,
    tabInstanceIds: [...pane.tabInstanceIds, node.instanceId],
  }));
  if (root === state.root) return state;
  return {
    ...state,
    root,
    tilesByInstanceId: withTile(state.tilesByInstanceId, node),
  };
}

/**
 * Open `ref` into an explicit `paneId` as a fresh tab instance, bypassing
 * global dedup. Unlike {@link openTile}, this is the opener's path: it
 * never focuses an already-open tab and never falls back to the active pane.
 *
 * - mints a fresh `instanceId` (a second view of the same content `id` is
 *   allowed - the two tabs differ only by `instanceId`),
 * - inserts into the explicit pane (no active-pane resolution),
 * - makes the target pane and the new tab active.
 *
 * Fill-in-place: when the pane's active tab is a blank "New tab", the picked
 * content replaces it at the same index (browser new-tab semantics).
 *
 * No-op when the canvas is empty or `paneId` does not resolve to a pane.
 */
export function openTileInPane(
  state: EpicCanvasState,
  paneId: string,
  ref: EpicCanvasTileRef,
): EpicCanvasState {
  if (state.root === null) return state;
  const target = findPaneById(state.root, paneId);
  if (target === null) return state;
  const node: EpicCanvasTileRef = { ...ref, instanceId: uuidv4() };
  const active = resolveActiveTabInstance(target);
  const activeRef =
    active === null
      ? null
      : (state.tilesByInstanceId[active.instanceId] ?? null);

  if (active !== null && activeRef !== null && isBlankTileRef(activeRef)) {
    const tabInstanceIds = target.tabInstanceIds.map((id, index) =>
      index === active.index ? node.instanceId : id,
    );
    // Replace the blank in place; clear preview if it pointed at the blank.
    const root = replacePane(state.root, paneId, (pane) => {
      const nextPane = prunePaneActivationHistory(
        {
          ...pane,
          tabInstanceIds,
          activeTabId: node.instanceId,
          previewTabId:
            pane.previewTabId === active.instanceId ? null : pane.previewTabId,
        },
        tabInstanceIds,
      );
      return recordPaneActivation(nextPane, node.instanceId);
    });
    return {
      ...state,
      root,
      activePaneId: paneId,
      tilesByInstanceId: withTile(
        withoutTiles(state.tilesByInstanceId, [active.instanceId]),
        node,
      ),
    };
  }

  const inserted = insertTabInstance(
    target,
    node.instanceId,
    target.tabInstanceIds.length,
    false,
  );
  const root = replacePane(state.root, paneId, () =>
    recordPaneActivation(inserted.pane, node.instanceId),
  );
  return {
    ...state,
    root,
    activePaneId: paneId,
    tilesByInstanceId: withTile(state.tilesByInstanceId, node),
  };
}

/**
 * Open a blank "New tab" in `paneId`, made active, with the pane made
 * globally active. Reuse-if-active-is-blank: when the pane's active tab is
 * already blank, just focus it (no stacking) so repeated invocations don't
 * pile up empty tabs.
 */
export function openBlankTabInPane(
  state: EpicCanvasState,
  paneId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const target = findPaneById(state.root, paneId);
  if (target === null) return state;
  const active = resolveActiveTabInstance(target);
  const activeRef =
    active === null
      ? null
      : (state.tilesByInstanceId[active.instanceId] ?? null);
  if (active !== null && activeRef !== null && isBlankTileRef(activeRef)) {
    const root = replacePane(state.root, paneId, (pane) =>
      pane.activeTabId === active.instanceId
        ? recordPaneActivation(pane, active.instanceId)
        : recordPaneActivation(
            { ...pane, activeTabId: active.instanceId },
            active.instanceId,
          ),
    );
    if (root === state.root && state.activePaneId === paneId) return state;
    return { ...state, root, activePaneId: paneId };
  }
  const node = makeBlankTileRef();
  const inserted = insertTabInstance(
    target,
    node.instanceId,
    target.tabInstanceIds.length,
    false,
  );
  const root = replacePane(state.root, paneId, () =>
    recordPaneActivation(inserted.pane, node.instanceId),
  );
  return {
    ...state,
    root,
    activePaneId: paneId,
    tilesByInstanceId: withTile(state.tilesByInstanceId, node),
  };
}

// ---------------------------------------------------------------------------
// Activation / preview
// ---------------------------------------------------------------------------

/** Promote the pane's preview tab to permanent (clear `previewTabId`). */
export function promotePreview(
  state: EpicCanvasState,
  paneId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const root = replacePane(state.root, paneId, (pane) =>
    pane.previewTabId === null ? pane : { ...pane, previewTabId: null },
  );
  if (root === state.root) return state;
  return { ...state, root };
}

/**
 * Set the active tab within a pane; also focus that pane globally.
 * `tabId` is a tab `instanceId`.
 */
export function setActiveTab(
  state: EpicCanvasState,
  paneId: string,
  tabId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const pane = findPaneById(state.root, paneId);
  if (pane === null) return state;
  if (!pane.tabInstanceIds.includes(tabId)) return state;
  if (pane.activeTabId === tabId && state.activePaneId === paneId) {
    return state;
  }
  const root = replacePane(state.root, paneId, (current) =>
    recordPaneActivation(current, tabId),
  );
  return { ...state, root, activePaneId: paneId };
}

/** Set the globally-active pane without changing its active tab. */
export function setActivePane(
  state: EpicCanvasState,
  paneId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  if (state.activePaneId === paneId) return state;
  if (findPaneById(state.root, paneId) === null) return state;
  return { ...state, activePaneId: paneId };
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

/**
 * Close the tab `tabId` (an instanceId) from `paneId`. Cascade: if removal
 * empties the pane AND it isn't the root, the pane is removed and its parent
 * group shrinks (dissolving when one child remains). The root pane is
 * preserved as an empty drop zone.
 */
export function closeTab(
  state: EpicCanvasState,
  paneId: string,
  tabId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const pane = findPaneById(state.root, paneId);
  if (pane === null) return state;
  const index = pane.tabInstanceIds.indexOf(tabId);
  if (index === -1) return state;
  const removed =
    pane.activeTabId === tabId
      ? removeTabAtIndexWithSyntheticFallback(pane, index)
      : removeTabAtIndexPruneOnly(pane, index);
  if (removed.pane.tabInstanceIds.length > 0) {
    const root = replacePane(state.root, paneId, () => removed.pane);
    return {
      ...state,
      root,
      tilesByInstanceId: withoutTiles(state.tilesByInstanceId, [tabId]),
    };
  }
  return closePane(state, paneId);
}

/** Close every tab except `tabId` (an instanceId) in `paneId`. */
export function closeOtherTabs(
  state: EpicCanvasState,
  paneId: string,
  tabId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const pane = findPaneById(state.root, paneId);
  if (pane === null) return state;
  if (!pane.tabInstanceIds.includes(tabId)) return state;
  if (pane.tabInstanceIds.length === 1) return state;
  const removedIds = pane.tabInstanceIds.filter((id) => id !== tabId);
  const root = replacePane(state.root, paneId, (current) =>
    recordPaneActivation(
      prunePaneActivationHistory(
        {
          ...current,
          tabInstanceIds: [tabId],
          activeTabId: tabId,
          previewTabId:
            current.previewTabId === tabId ? current.previewTabId : null,
        },
        [tabId],
      ),
      tabId,
    ),
  );
  return {
    ...state,
    root,
    tilesByInstanceId: withoutTiles(state.tilesByInstanceId, removedIds),
  };
}

/** Close every tab to the right of `tabId` (an instanceId) in `paneId`. */
export function closeRightTabs(
  state: EpicCanvasState,
  paneId: string,
  tabId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const pane = findPaneById(state.root, paneId);
  if (pane === null) return state;
  const index = pane.tabInstanceIds.indexOf(tabId);
  if (index === -1 || index === pane.tabInstanceIds.length - 1) return state;
  const kept = pane.tabInstanceIds.slice(0, index + 1);
  const removedIds = pane.tabInstanceIds.slice(index + 1);
  const activeTabId =
    pane.activeTabId !== null && kept.includes(pane.activeTabId)
      ? pane.activeTabId
      : kept[kept.length - 1];
  const previewTabId =
    pane.previewTabId !== null && kept.includes(pane.previewTabId)
      ? pane.previewTabId
      : null;
  const shouldRecordTarget =
    pane.activeTabId === null || removedIds.includes(pane.activeTabId);
  const root = replacePane(state.root, paneId, (current) => {
    const nextPane = prunePaneActivationHistory(
      {
        ...current,
        tabInstanceIds: kept,
        activeTabId,
        previewTabId,
      },
      kept,
    );
    return shouldRecordTarget
      ? recordPaneActivation(nextPane, tabId)
      : nextPane;
  });
  return {
    ...state,
    root,
    tilesByInstanceId: withoutTiles(state.tilesByInstanceId, removedIds),
  };
}

/**
 * Close every tab in `paneId`. Cascade rule from `closeTab` applies -
 * a non-root pane is removed; the root pane is left empty.
 */
export function closeAllTabs(
  state: EpicCanvasState,
  paneId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const pane = findPaneById(state.root, paneId);
  if (pane === null) return state;
  if (pane.tabInstanceIds.length === 0) return state;
  return closePane(state, paneId);
}

/**
 * Remove a pane entirely. If non-root, the parent group shrinks (dissolving
 * when a single child remains). If root, the pane is replaced with an empty
 * pane so the canvas surface remains a drop target.
 */
export function closePane(
  state: EpicCanvasState,
  paneId: string,
): EpicCanvasState {
  if (state.root === null) return state;
  const pane = findPaneById(state.root, paneId);
  if (pane === null) return state;
  const tiles = withoutTiles(state.tilesByInstanceId, pane.tabInstanceIds);
  const removal = removePaneFromTree(
    { root: state.root, sizesByGroupId: state.sizesByGroupId },
    paneId,
  );
  if (removal === null) return state;
  if (removal.root === null) {
    // Removed the root pane; preserve the canvas as an empty drop zone.
    const empty = createEmptyPane();
    return {
      root: empty,
      activePaneId: empty.id,
      tilesByInstanceId: tiles,
      sizesByGroupId: {},
    };
  }
  const wasActive = state.activePaneId === paneId;
  const activePaneId = wasActive
    ? firstPaneId(removal.root)
    : (state.activePaneId ?? firstPaneId(removal.root));
  return {
    root: removal.root,
    activePaneId,
    tilesByInstanceId: tiles,
    sizesByGroupId: removal.sizesByGroupId,
  };
}

// ---------------------------------------------------------------------------
// Tab strip drops (reorder / move / insert)
// ---------------------------------------------------------------------------

type TabStripSource =
  | { kind: "node"; node: EpicCanvasTileRef }
  | {
      kind: "tab";
      sourcePaneId: string;
      // Tab `instanceId` (per-tab identity), not the content `id`.
      tabId: string;
      node: EpicCanvasTileRef;
    };

function reorderTabInPane(
  state: EpicCanvasState,
  pane: TilePane,
  tabId: string,
  targetIndex: number,
): EpicCanvasState {
  const fromIndex = pane.tabInstanceIds.indexOf(tabId);
  if (fromIndex === -1) return state;
  const adjustedIndex = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  if (adjustedIndex === fromIndex) {
    const wantsActive = state.activePaneId !== pane.id;
    const wantsPromote = pane.previewTabId === tabId;
    if (!wantsActive && !wantsPromote) return state;
    const root =
      state.root === null
        ? null
        : replacePane(state.root, pane.id, (current) =>
            wantsPromote ? { ...current, previewTabId: null } : current,
          );
    return { ...state, root, activePaneId: pane.id };
  }
  const tabInstanceIds = [...pane.tabInstanceIds];
  tabInstanceIds.splice(fromIndex, 1);
  tabInstanceIds.splice(adjustedIndex, 0, tabId);
  const nextPane = recordPaneActivation(
    prunePaneActivationHistory(
      {
        ...pane,
        tabInstanceIds,
        activeTabId: tabId,
        previewTabId: pane.previewTabId === tabId ? null : pane.previewTabId,
      },
      tabInstanceIds,
    ),
    tabId,
  );
  const root =
    state.root === null
      ? null
      : replacePane(state.root, pane.id, () => nextPane);
  return { ...state, root, activePaneId: pane.id };
}

function moveTabAcrossPanes(
  state: EpicCanvasState,
  args: {
    readonly sourcePaneId: string;
    readonly tabId: string;
    readonly targetPaneId: string;
    readonly targetIndex: number;
  },
): EpicCanvasState {
  if (state.root === null) return state;
  const sourcePane = findPaneById(state.root, args.sourcePaneId);
  if (sourcePane === null) return state;
  const fromIndex = sourcePane.tabInstanceIds.indexOf(args.tabId);
  if (fromIndex === -1) return state;

  const removed = removeTabAtIndexWithSyntheticFallback(sourcePane, fromIndex);
  let root = replacePane(state.root, args.sourcePaneId, () => removed.pane);
  const targetPane = findPaneById(root, args.targetPaneId);
  if (targetPane === null) return state;
  const inserted = insertTabInstance(
    targetPane,
    args.tabId,
    args.targetIndex,
    false,
  );
  root = replacePane(root, args.targetPaneId, () =>
    recordPaneActivation(inserted.pane, args.tabId),
  );

  let next: EpicCanvasState = {
    ...state,
    root,
    activePaneId: args.targetPaneId,
  };
  if (removed.pane.tabInstanceIds.length === 0) {
    next = closePane(next, args.sourcePaneId);
    // closePane resets the active pane to the first pane; restore the drop
    // target as the globally-active pane.
    next =
      next.activePaneId === args.targetPaneId
        ? next
        : { ...next, activePaneId: args.targetPaneId };
  }
  return next;
}

/**
 * Insert / move a tab into the destination pane's tab strip at
 * `targetIndex`. Handles both `'node'` (new from sidebar) and `'tab'`
 * (existing tab being moved cross-pane) sources. Node drops preserve
 * single-open-tab semantics by moving an already-open node instead of
 * creating a duplicate or only focusing the existing tab.
 */
export function dropOnTabStrip(
  state: EpicCanvasState,
  source: TabStripSource,
  targetPaneId: string,
  targetIndex: number,
): EpicCanvasState {
  if (state.root === null) return state;
  const targetPane = findPaneById(state.root, targetPaneId);
  if (targetPane === null) return state;

  if (source.kind === "node") {
    const existing = findPaneTabByContentId(state, source.node.id);
    if (existing !== null) {
      if (existing.pane.id === targetPaneId) {
        return reorderTabInPane(
          state,
          existing.pane,
          existing.instanceId,
          targetIndex,
        );
      }
      return moveTabAcrossPanes(state, {
        sourcePaneId: existing.pane.id,
        tabId: existing.instanceId,
        targetPaneId,
        targetIndex,
      });
    }
    const inserted = insertTabInstance(
      targetPane,
      source.node.instanceId,
      targetIndex,
      false,
    );
    const root = replacePane(state.root, targetPaneId, () =>
      recordPaneActivation(inserted.pane, source.node.instanceId),
    );
    return {
      ...state,
      root,
      activePaneId: targetPaneId,
      tilesByInstanceId: withTile(state.tilesByInstanceId, source.node),
    };
  }

  if (source.sourcePaneId === targetPaneId) {
    return reorderTabInPane(state, targetPane, source.tabId, targetIndex);
  }
  return moveTabAcrossPanes(state, {
    sourcePaneId: source.sourcePaneId,
    tabId: source.tabId,
    targetPaneId,
    targetIndex,
  });
}

// ---------------------------------------------------------------------------
// Edge splits
// ---------------------------------------------------------------------------

interface ResolvedSplitSource {
  readonly state: EpicCanvasState;
  readonly node: EpicCanvasTileRef;
  readonly collapseSourcePaneId: string | null;
}

function resolveSplitSource(
  state: EpicCanvasState,
  targetPaneId: string,
  source: TabStripSource,
): ResolvedSplitSource | null {
  if (source.kind === "node") {
    return {
      state: {
        ...state,
        tilesByInstanceId: withTile(state.tilesByInstanceId, source.node),
      },
      node: source.node,
      collapseSourcePaneId: null,
    };
  }
  if (state.root === null) return null;
  const sourcePane = findPaneById(state.root, source.sourcePaneId);
  if (sourcePane === null) return null;
  const fromIndex = sourcePane.tabInstanceIds.indexOf(source.tabId);
  if (fromIndex === -1) return null;
  // Splitting a single-tab source pane onto its own edge would just
  // rearrange the same pane - reject as no-op.
  if (
    source.sourcePaneId === targetPaneId &&
    sourcePane.tabInstanceIds.length === 1
  ) {
    return null;
  }
  const ref = state.tilesByInstanceId[source.tabId];
  if (ref === undefined) return null;
  const removed = removeTabAtIndexWithSyntheticFallback(sourcePane, fromIndex);
  const root = replacePane(state.root, source.sourcePaneId, () => removed.pane);
  return {
    state: { ...state, root },
    node: ref,
    collapseSourcePaneId:
      removed.pane.tabInstanceIds.length === 0 ? source.sourcePaneId : null,
  };
}

/**
 * Drop an item on a pane's body edge - splits the pane at that edge with the
 * dragged item populating the new sibling pane. When the pane's parent group
 * already runs in the drop direction the new pane joins that group (the
 * tree stays flat); otherwise the pane is wrapped in a fresh group. The new
 * pane becomes globally active. Both `'node'` and `'tab'` sources are
 * handled; cross-pane tab moves remove from the source first. Drops that
 * would exceed the depth cap are no-ops.
 */
export function splitPaneAtEdge(
  state: EpicCanvasState,
  targetPaneId: string,
  position: EdgeDropPosition,
  source: TabStripSource,
): EpicCanvasState {
  if (state.root === null) {
    if (source.kind === "node") return seedRootPane(source.node, false);
    return state;
  }

  if (source.kind === "node") {
    const existing = findPaneTabByContentId(state, source.node.id);
    if (existing !== null) {
      return splitPaneAtEdge(state, targetPaneId, position, {
        kind: "tab",
        sourcePaneId: existing.pane.id,
        tabId: existing.instanceId,
        node: existing.ref,
      });
    }
  }

  const resolved = resolveSplitSource(state, targetPaneId, source);
  if (resolved === null) return state;
  const working = resolved.state;
  if (working.root === null) return state;

  // The dragged tab keeps its instanceId (a moved tab is the same tab).
  const pane = createPaneWithTab(resolved.node, false);
  const insertion = insertPaneAtEdge({
    state: { root: working.root, sizesByGroupId: working.sizesByGroupId },
    targetPaneId,
    newPane: pane,
    position,
    createGroupId: uuidv4,
  });
  if (insertion === null) return state;

  let next: EpicCanvasState = {
    ...working,
    root: insertion.root,
    sizesByGroupId: insertion.sizesByGroupId,
    activePaneId: pane.id,
  };
  if (resolved.collapseSourcePaneId !== null) {
    next = closePane(next, resolved.collapseSourcePaneId);
    next =
      next.activePaneId === pane.id ? next : { ...next, activePaneId: pane.id };
  }
  return next;
}

/**
 * Split `paneId` along `direction`, placing an empty placeholder pane on the
 * trailing side (right for horizontal, bottom for vertical). The empty pane
 * becomes globally active so a subsequent sidebar click lands there.
 * Depth-capped like every other split.
 */
export function splitPaneEmpty(
  state: EpicCanvasState,
  paneId: string,
  direction: SplitDirection,
): EpicCanvasState {
  if (state.root === null) return state;
  if (findPaneById(state.root, paneId) === null) return state;
  const empty = createEmptyPane();
  const insertion = insertPaneAtEdge({
    state: { root: state.root, sizesByGroupId: state.sizesByGroupId },
    targetPaneId: paneId,
    newPane: empty,
    position: direction === "horizontal" ? "right" : "bottom",
    createGroupId: uuidv4,
  });
  if (insertion === null) return state;
  return {
    ...state,
    root: insertion.root,
    sizesByGroupId: insertion.sizesByGroupId,
    activePaneId: empty.id,
  };
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

function sizesEqual(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Commit a group's child fractions (clamped + normalized). Touches ONLY
 * `sizesByGroupId` - the tree object is untouched, so layout subscribers
 * keyed on `root` never re-render for a resize. `groupId` addresses a split
 * container (NOT a pane) - the one place the canvas API takes a group id.
 */
export function resizeSplit(
  state: EpicCanvasState,
  groupId: string,
  sizes: ReadonlyArray<number>,
): EpicCanvasState {
  if (state.root === null) return state;
  const clamped = clampNormalizedSizes(sizes);
  const current = state.sizesByGroupId[groupId];
  if (current !== undefined && sizesEqual(current, clamped)) return state;
  return {
    ...state,
    sizesByGroupId: { ...state.sizesByGroupId, [groupId]: clamped },
  };
}

// ---------------------------------------------------------------------------
// Tile payload updates (tree untouched - the decoupling win)
// ---------------------------------------------------------------------------

function updateTilesWhere(
  state: EpicCanvasState,
  matches: (ref: EpicCanvasTileRef) => boolean,
  update: (ref: EpicCanvasTileRef) => EpicCanvasTileRef,
): EpicCanvasState {
  let changed = false;
  const next: Record<string, EpicCanvasTileRef> = {};
  for (const [instanceId, ref] of Object.entries(state.tilesByInstanceId)) {
    if (ref === undefined) continue;
    if (matches(ref)) {
      const updated = update(ref);
      next[instanceId] = updated;
      if (updated !== ref) changed = true;
    } else {
      next[instanceId] = ref;
    }
  }
  if (!changed) return state;
  return { ...state, tilesByInstanceId: next };
}

/**
 * Rename an artifact in every tab that holds it (by content id). Returns
 * unchanged state if no tab matches.
 */
export function renameArtifact(
  state: EpicCanvasState,
  artifactId: string,
  name: string,
): EpicCanvasState {
  return updateTilesWhere(
    state,
    (ref) => ref.id === artifactId,
    (ref) => {
      if (ref.type !== "terminal") {
        return ref.name === name ? ref : { ...ref, name };
      }
      if (ref.name === name && ref.titleSource === "manual") return ref;
      return { ...ref, name, titleSource: "manual" };
    },
  );
}

/**
 * Refresh the persisted `name` snapshot of every terminal tile bound to
 * (hostId, sessionId) after a successful host rename. The snapshot is the
 * restart-recovery fallback only - live rendering reads the host's
 * `terminal.list` rows - so this runs post-success, never optimistically.
 * Matched by content id AND host binding: session ids are only unique per
 * host, so a bare id match could rename another host's tile.
 */
export function renameTerminalTiles(
  state: EpicCanvasState,
  hostId: string,
  sessionId: string,
  name: string,
): EpicCanvasState {
  return updateTilesWhere(
    state,
    (ref) =>
      ref.type === "terminal" && ref.id === sessionId && ref.hostId === hostId,
    (ref) => {
      if (ref.type !== "terminal") return ref;
      if (ref.name === name && ref.titleSource === "manual") return ref;
      return { ...ref, name, titleSource: "manual" };
    },
  );
}

export function updateGitDiffTileView(
  state: EpicCanvasState,
  tileId: string,
  view: GitDiffTileViewState,
): EpicCanvasState {
  return updateTilesWhere(
    state,
    (ref) => ref.id === tileId && isGitDiffTileRef(ref),
    (ref) => ({ ...ref, view }),
  );
}

export function updateSnapshotDiffTileView(
  state: EpicCanvasState,
  tileId: string,
  view: GitDiffTileViewState,
): EpicCanvasState {
  return updateTilesWhere(
    state,
    (ref) => ref.id === tileId && isSnapshotDiffTileRef(ref),
    (ref) => ({ ...ref, view }),
  );
}

export function toggleGitDiffBundleFileCollapsed(
  state: EpicCanvasState,
  tileId: string,
  filePath: string,
): EpicCanvasState {
  return updateTilesWhere(
    state,
    (ref) =>
      ref.id === tileId && isGitDiffTileRef(ref) && ref.diff.kind === "bundle",
    (ref) => toggleCollapsedFilePath(ref, filePath),
  );
}

export function toggleSnapshotDiffBundleFileCollapsed(
  state: EpicCanvasState,
  tileId: string,
  filePath: string,
): EpicCanvasState {
  return updateTilesWhere(
    state,
    (ref) =>
      ref.id === tileId &&
      isSnapshotDiffTileRef(ref) &&
      ref.diff.kind === "snapshot-cumulative-bundle",
    (ref) => toggleCollapsedFilePath(ref, filePath),
  );
}

function toggleCollapsedFilePath(
  ref: EpicCanvasTileRef,
  filePath: string,
): EpicCanvasTileRef {
  if (!isGitDiffTileRef(ref) && !isSnapshotDiffTileRef(ref)) return ref;
  const collapsed = new Set(ref.view.collapsedFilePaths);
  if (collapsed.has(filePath)) {
    collapsed.delete(filePath);
  } else {
    collapsed.add(filePath);
  }
  return { ...ref, view: { ...ref.view, collapsedFilePaths: [...collapsed] } };
}

export { sizesForGroup } from "./tile-tree";
export type { TabStripSource };
