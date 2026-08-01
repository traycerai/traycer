/**
 * Selector / hook layer over `useEpicCanvasStore`. Per-id selector
 * factories are documented in `selector_usage_readme.md`: construct once
 * per id with `useMemo(() => makeSelectX(id), [id])`, then pass that
 * selector to `useEpicCanvasStore`. Re-exported from `store.ts` so existing
 * import sites keep working.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";
import {
  type EpicCanvasTileRef,
  type EpicCanvasState,
  type EpicViewTab,
  type TileLayoutNode,
  type TilePane,
} from "./types";
import { isTileRefRecordBacked } from "./tile-schema";
import { findPaneById } from "./tile-tree";
import { EMPTY_CANVAS } from "./canvas-state";
import { findPaneTabByContentId } from "./actions";
import { EMPTY_RECORDS } from "./canvas-desktop-projection";
import {
  resolveTabIdForEpic,
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "./store";

export function useOpenEpicTabs(): ReadonlyArray<EpicViewTab> {
  return useEpicCanvasStore(
    useShallow((state) =>
      state.openTabOrder.flatMap((tabId) => {
        const tab = state.tabsById[tabId];
        return tab === undefined ? [] : [tab];
      }),
    ),
  );
}

export function useActiveTabId(): string | null {
  return useEpicCanvasStore((state) => state.activeTabId);
}

export function useActiveEpicId(): string | null {
  return useEpicCanvasStore((state) => {
    if (state.activeTabId === null) return null;
    return state.tabsById[state.activeTabId]?.epicId ?? null;
  });
}

/**
 * Distinct epic ids that currently have at least one open tab, in tab order.
 * Imperative read (not a hook) shared by app-level reconcilers that walk the
 * open set on store/registry events - keeps the openTabOrder→epicId derivation
 * in one place instead of each provider re-deriving it.
 */
export function collectOpenEpicIds(): ReadonlyArray<string> {
  const state = useEpicCanvasStore.getState();
  const seen = new Set<string>();
  return state.openTabOrder
    .map((tabId) => state.tabsById[tabId])
    .flatMap((tab) => {
      if (tab === undefined || seen.has(tab.epicId)) return [];
      seen.add(tab.epicId);
      return [tab.epicId];
    });
}

/**
 * Best-available display name for an epic from its open tabs, preferring the
 * active/MRU tab via `resolveTabIdForEpic` so it matches what the strip
 * highlights (a naive first-in-order walk could surface a stale name when the
 * epic has several tabs). Imperative read shared by app-level reconcilers.
 * Returns `null` when the epic has no open tab with a non-empty name.
 */
export function epicTabName(epicId: string): string | null {
  const state = useEpicCanvasStore.getState();
  const tabId = resolveTabIdForEpic(state, epicId);
  if (tabId === null) return null;
  const name = state.tabsById[tabId]?.name ?? "";
  return name.length > 0 ? name : null;
}

export function makeSelectEpicTab(tabId: string | undefined) {
  return (state: EpicCanvasStore): EpicViewTab | null => {
    if (tabId === undefined) return null;
    return state.tabsById[tabId] ?? null;
  };
}

export function useEpicTab(tabId: string | undefined): EpicViewTab | null {
  const selector = useMemo(() => makeSelectEpicTab(tabId), [tabId]);
  return useEpicCanvasStore(selector);
}

export function makeSelectEpicArtifactRecords(epicId: string | undefined) {
  return (state: EpicCanvasStore): ReadonlyArray<EpicNodeRecord> => {
    if (epicId === undefined) return EMPTY_RECORDS;
    return state.artifactTreeByEpicId[epicId] ?? EMPTY_RECORDS;
  };
}

export function useEpicArtifactRecords(
  epicId: string | undefined,
): ReadonlyArray<EpicNodeRecord> {
  const selector = useMemo(
    () => makeSelectEpicArtifactRecords(epicId),
    [epicId],
  );
  return useEpicCanvasStore(selector);
}

/**
 * Whether `ref`'s backing artifact record is still live: not a record-backed
 * kind at all (terminal, workspace-file, git-diff - nothing to go stale),
 * still within the optimistic-create window (`pendingCreateArtifactIds`,
 * before a just-created record has projected), or `hasLiveRecord` finds it.
 *
 * `hasLiveRecord` is a caller-supplied presence check rather than a fixed
 * records array, because the two consumers reach live record data through
 * genuinely different paths: `useEpicRouteSynchronization`'s cleanup effect
 * (closes an OPEN tile whose record disappeared) has a React-context-bound
 * live records array in hand, while the back/forward preview-reopen path
 * (must not resurrect a CLOSED tile whose record disappeared while it was
 * closed) has only an epicId and looks the session up imperatively via the
 * open-Epic session registry. Sharing this predicate keeps the "record-
 * backed + pending-create-exempt" decision itself from drifting between the
 * two - only the presence lookup differs.
 */
export function isTileRefRecordLive(
  ref: EpicCanvasTileRef,
  pendingCreateArtifactIds: ReadonlySet<string>,
  hasLiveRecord: (id: string) => boolean,
): boolean {
  if (!isTileRefRecordBacked(ref)) return true;
  if (pendingCreateArtifactIds.has(ref.id)) return true;
  return hasLiveRecord(ref.id);
}

export function makeSelectEpicCanvas(tabId: string | undefined) {
  return (state: EpicCanvasStore): EpicCanvasState => {
    if (tabId === undefined) return EMPTY_CANVAS;
    return state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
  };
}

export function useEpicCanvas(tabId: string | undefined): EpicCanvasState {
  const selector = useMemo(() => makeSelectEpicCanvas(tabId), [tabId]);
  return useEpicCanvasStore(selector);
}

export function makeSelectActiveEpicArtifactId(tabId: string | undefined) {
  const selectRef = makeSelectActiveEpicArtifactRef(tabId);
  return (state: EpicCanvasStore): string | null =>
    selectRef(state)?.id ?? null;
}

export function useActiveEpicArtifactId(
  tabId: string | undefined,
): string | null {
  const selector = useMemo(
    () => makeSelectActiveEpicArtifactId(tabId),
    [tabId],
  );
  return useEpicCanvasStore(selector);
}

/**
 * Same active-tile resolution and filtering as
 * {@link makeSelectActiveEpicArtifactId}, but returns the ref itself rather
 * than just its id - callers that need to discriminate the active tile's
 * kind (e.g. "chat" vs "terminal-agent" for support-context capture) would
 * otherwise have to re-walk the pane tree.
 */
/**
 * The tile showing in `tabId`'s ACTIVE pane, or `null`. The one place the
 * active-pane walk lives, shared by every selector below it - the rules for
 * "which tile is the user looking at" must not be able to drift between the
 * record-backed and renderer-only answers.
 */
function activeTileRef(
  state: EpicCanvasStore,
  tabId: string | undefined,
): EpicCanvasTileRef | null {
  if (tabId === undefined) return null;
  const canvas = state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
  if (canvas.activePaneId === null) return null;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.activeTabId === null) return null;
  return canvas.tilesByInstanceId[pane.activeTabId] ?? null;
}

export function makeSelectActiveEpicArtifactRef(tabId: string | undefined) {
  return (state: EpicCanvasStore): EpicCanvasTileRef | null => {
    const active = activeTileRef(state, tabId);
    if (active === null) return null;
    // Only record-backed tiles are resolvable artifacts. Renderer-only tiles -
    // workspace file, git-diff, comm-graph, and the PR detail/diff pair -
    // carry synthetic ids that cannot be restored from artifact records, so
    // they must never become the persisted `lastFocusedArtifactId` (route
    // sync writes whatever this returns). `isTileRefRecordBacked` covers
    // every one of them and any future kind.
    if (!isTileRefRecordBacked(active)) return null;
    return active;
  };
}

export function useActiveEpicArtifactRef(
  tabId: string | undefined,
): EpicCanvasTileRef | null {
  const selector = useMemo(
    () => makeSelectActiveEpicArtifactRef(tabId),
    [tabId],
  );
  return useEpicCanvasStore(selector);
}

/**
 * Whether `nodeId` is the active artifact in `tabId`, as a boolean. Sidebar tree
 * nodes subscribe per-node via this instead of receiving the tab-wide
 * `activeArtifactId` as a prop: with the id threaded to every node, selecting an
 * artifact gave all ~20 nodes a new prop and re-rendered the whole tree (+ each
 * node's dropdown/context menus). Selecting on a per-node BOOLEAN means Zustand
 * re-renders only the two nodes whose active state actually flips.
 */
export function makeSelectIsActiveEpicArtifact(
  tabId: string | undefined,
  nodeId: string,
) {
  const selectActiveId = makeSelectActiveEpicArtifactId(tabId);
  return (state: EpicCanvasStore): boolean => selectActiveId(state) === nodeId;
}

export function useIsActiveEpicArtifact(
  tabId: string | undefined,
  nodeId: string,
): boolean {
  const selector = useMemo(
    () => makeSelectIsActiveEpicArtifact(tabId, nodeId),
    [tabId, nodeId],
  );
  return useEpicCanvasStore(selector);
}

/**
 * Whether `tileId` is the tile showing in `tabId`'s active pane - the
 * NON-record-backed counterpart to {@link makeSelectIsActiveEpicArtifact}.
 *
 * Renderer-only tiles (workspace file, git-diff, PR detail) are deliberately
 * invisible to `makeSelectActiveEpicArtifactId`, which returns `null` for them
 * so their synthetic ids never reach the persisted `lastFocusedArtifactId`.
 * They still need to light up their own list row, and their ids ARE stable
 * (derived from host + coordinates), so matching on the tile id directly is
 * safe here in a way that persisting it would not be.
 *
 * `null` means "this row has no tile" (an unknown-base PR) and is never active.
 * Selects a per-row BOOLEAN for the same reason the artifact variant does:
 * threading the active id to every row re-renders the whole list on every
 * selection change.
 */
export function makeSelectIsActiveTile(
  tabId: string | undefined,
  tileId: string | null,
) {
  return (state: EpicCanvasStore): boolean => {
    if (tileId === null) return false;
    return activeTileRef(state, tabId)?.id === tileId;
  };
}

export function useIsActiveTile(
  tabId: string | undefined,
  tileId: string | null,
): boolean {
  const selector = useMemo(
    () => makeSelectIsActiveTile(tabId, tileId),
    [tabId, tileId],
  );
  return useEpicCanvasStore(selector);
}

/**
 * Whether `paneId` is the globally-active pane in `tabId`, as a boolean. Every
 * pane view subscribes per-pane via this instead of reading the raw
 * `activePaneId`: with the raw id, opening/switching the active pane changed
 * the selector output for EVERY pane and re-rendered all of them (each one's
 * tab strip, context menus, and framer-motion layout) even though only two
 * panes' active state actually flipped. The per-pane boolean re-renders only
 * those two. Mirrors `makeSelectIsActiveEpicArtifact`.
 */
export function makeSelectIsActivePane(
  tabId: string | undefined,
  paneId: string,
) {
  return (state: EpicCanvasStore): boolean => {
    if (tabId === undefined) return false;
    return (state.canvasByTabId[tabId]?.activePaneId ?? null) === paneId;
  };
}

export function useIsActivePane(
  tabId: string | undefined,
  paneId: string,
): boolean {
  const selector = useMemo(
    () => makeSelectIsActivePane(tabId, paneId),
    [tabId, paneId],
  );
  return useEpicCanvasStore(selector);
}

interface TabActivation {
  readonly isActive: boolean;
  readonly isPreview: boolean;
  readonly isGloballyActive: boolean;
}

const TAB_ACTIVATION_NONE: TabActivation = {
  isActive: false,
  isPreview: false,
  isGloballyActive: false,
};

/**
 * Per-tab activation flags for one tile tab, as a shallow-compared bag. Each
 * `TabItem` subscribes via this instead of receiving `isActive`/`isPreview`/
 * `isGloballyActive` as props derived from the pane's `activeTabId` inside the
 * strip's `tabs.map(...)`: those pane-level scalars were map-closure deps, so
 * React Compiler re-ran the whole map on any active/preview change and
 * re-rendered every tab (+ its context menu, tooltip, and layout frame) even
 * for a pure active-switch where the pane's tabs identity is unchanged. Reading
 * the flags per tab means the map only re-runs on real structural change
 * (add/remove/reorder) and an active-switch re-renders just the two tabs whose
 * flags flip. Use through `useTabActivation` (wrapped in `useShallow`).
 */
export function makeSelectTabActivation(
  tabId: string | undefined,
  paneId: string,
  tileTabId: string,
) {
  return (state: EpicCanvasStore): TabActivation => {
    if (tabId === undefined) return TAB_ACTIVATION_NONE;
    const canvas = state.canvasByTabId[tabId] ?? EMPTY_CANVAS;
    const pane = findPaneById(canvas.root, paneId);
    if (pane === null) return TAB_ACTIVATION_NONE;
    const isActive = pane.activeTabId === tileTabId;
    return {
      isActive,
      isPreview: pane.previewTabId === tileTabId,
      isGloballyActive: isActive && canvas.activePaneId === paneId,
    };
  };
}

export function useTabActivation(
  tabId: string | undefined,
  paneId: string,
  tileTabId: string,
): TabActivation {
  const selector = useMemo(
    () => makeSelectTabActivation(tabId, paneId, tileTabId),
    [tabId, paneId, tileTabId],
  );
  return useEpicCanvasStore(useShallow(selector));
}

const EMPTY_TILE_REFS: ReadonlyArray<EpicCanvasTileRef> = [];

/**
 * A pane's tab payloads in strip order, subscribed with shallow comparison.
 * Tile payloads live in `tilesByInstanceId` (decoupled from the tree), so a
 * pane view resolves its OWN refs here and re-renders only when one of them
 * changes - payload churn in other panes never touches it.
 */
export function usePaneTabRefs(
  tabId: string | undefined,
  pane: TilePane,
): ReadonlyArray<EpicCanvasTileRef> {
  const selector = useMemo(
    () =>
      (state: EpicCanvasStore): ReadonlyArray<EpicCanvasTileRef> => {
        if (tabId === undefined) return EMPTY_TILE_REFS;
        const canvas = state.canvasByTabId[tabId];
        if (canvas === undefined) return EMPTY_TILE_REFS;
        const refs = pane.tabInstanceIds.flatMap((instanceId) => {
          const ref = canvas.tilesByInstanceId[instanceId];
          return ref === undefined ? [] : [ref];
        });
        return refs.length === 0 ? EMPTY_TILE_REFS : refs;
      },
    [pane, tabId],
  );
  return useEpicCanvasStore(useShallow(selector));
}

export function getCanvasRootForTab(tabId: string): TileLayoutNode | null {
  return useEpicCanvasStore.getState().canvasByTabId[tabId]?.root ?? null;
}

/**
 * Locate an open tab by content id in `tabId`'s canvas. Returns the holding
 * pane's id plus the tab's `instanceId` (activation/close key on instanceId).
 */
export function findOpenArtifactInTab(
  tabId: string,
  artifactId: string,
): { paneId: string; instanceId: string } | null {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  const found = findPaneTabByContentId(canvas, artifactId);
  if (found === null) return null;
  return { paneId: found.pane.id, instanceId: found.instanceId };
}
