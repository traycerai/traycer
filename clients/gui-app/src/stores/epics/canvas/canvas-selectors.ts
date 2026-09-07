/** Selector / hook layer over `useEpicCanvasStore`. */
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
import {
  findPaneTabByContentId,
  findPaneTabForRef,
  type TileIdentity,
} from "./actions";
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

/** Distinct epic ids that currently have at least one open tab, in tab order. */
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
 * Best-available display name for an epic from its open tabs, preferring the active/MRU tab via
 * `resolveTabIdForEpic` so it matches what the strip highlights (a naive first-in-order walk could
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
 * Whether `ref`'s backing artifact record is still live: not a record-backed kind at all
 * (terminal, workspace-file, git-diff - nothing to go stale), still within the optimistic-create
 */
export interface TileRefLivenessCheck {
  readonly hasLiveRecord: (id: string) => boolean;
  readonly isCloudKnown: (id: string) => boolean;
  readonly recordListAuthorizesChatAbsence: boolean;
}

/**
 * Whether this ref's record is HOST-AUTHORITATIVE - owned by one host's own registry rather than
 * by the shared epic document.
 */
export function isHostAuthoritativeRef(ref: EpicCanvasTileRef): boolean {
  return ref.type === "chat" || ref.type === "terminal-agent";
}

export function isTileRefRecordLive(
  ref: EpicCanvasTileRef,
  pendingCreateArtifactIds: ReadonlySet<string>,
  liveness: TileRefLivenessCheck,
  projectionHostId: string | null,
): boolean {
  const { hasLiveRecord, isCloudKnown } = liveness;
  if (!isTileRefRecordBacked(ref)) return true;
  // With no projection host yet, a disabled record query cannot classify a
  // ref as same-host or cross-host and therefore cannot prove it disappeared.
  if (isHostAuthoritativeRef(ref) && projectionHostId === null) return true;
  // A ref bound to ANOTHER host is not policed by this device's projection.
  if (
    isHostAuthoritativeRef(ref) &&
    projectionHostId !== null &&
    ref.hostId !== projectionHostId
  ) {
    return true;
  }
  if (pendingCreateArtifactIds.has(ref.id)) return true;
  if (hasLiveRecord(ref.id)) return true;
  if (ref.type !== "chat") return false;
  if (isCloudKnown(ref.id)) return true;
  return !liveness.recordListAuthorizesChatAbsence;
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
 * Same active-tile resolution and filtering as {@link makeSelectActiveEpicArtifactId}, but returns
 * the ref itself rather than just its id - callers that need to discriminate the active tile's
 */
/** The tile showing in `tabId`'s ACTIVE pane, or `null`. */
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
    // Only record-backed tiles are resolvable artifacts.
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

/** Whether `nodeId` is the active artifact in `tabId`, as a boolean. */
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
 * Whether `tileId` is the tile showing in `tabId`'s active pane - the NON-record-backed
 * counterpart to {@link makeSelectIsActiveEpicArtifact}.
 */
export function makeSelectIsActiveTile(
  tabId: string | undefined,
  tileId: string | null,
  hostId: string | null,
) {
  return (state: EpicCanvasStore): boolean => {
    if (tileId === null) return false;
    const active = activeTileRef(state, tabId);
    if (active === null || active.id !== tileId) return false;
    if (hostId === null) return true;
    return active.hostId === hostId;
  };
}

export function useIsActiveTile(
  tabId: string | undefined,
  tileId: string | null,
  hostId: string | null,
): boolean {
  const selector = useMemo(
    () => makeSelectIsActiveTile(tabId, tileId, hostId),
    [tabId, tileId, hostId],
  );
  return useEpicCanvasStore(selector);
}

/** Whether `paneId` is the globally-active pane in `tabId`, as a boolean. */
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

/** Per-tab activation flags for one tile tab, as a shallow-compared bag. */
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

/** A pane's tab payloads in strip order, subscribed with shallow comparison. */
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

const EMPTY_CONTENT_IDS: ReadonlySet<string> = new Set();

/**
 * Content ids of every tile open in `tabId`'s canvas - the "what is already on screen here"
 * question, for surfaces that offer to open something.
 */
export function useOpenTileContentIds(
  tabId: string | undefined,
): ReadonlySet<string> {
  const tiles = useEpicCanvas(tabId).tilesByInstanceId;
  return useMemo(() => {
    const ids = Object.values(tiles).flatMap((ref) =>
      ref === undefined ? [] : [ref.id],
    );
    return ids.length === 0 ? EMPTY_CONTENT_IDS : new Set(ids);
  }, [tiles]);
}

/**
 * Locate an open tab for a REF in `tabId`'s canvas - id and bound host both, the same identity
 * `openTile` dedups on.
 */
export function findOpenTileInTab(
  tabId: string,
  node: TileIdentity,
): { paneId: string; instanceId: string } | null {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  const found = findPaneTabForRef(canvas, node);
  if (found === null) return null;
  return { paneId: found.pane.id, instanceId: found.instanceId };
}

/**
 * Locate an open tab by content id in `tabId`'s canvas. Returns the holding pane's id plus the
 * tab's `instanceId` (activation/close key on instanceId).
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
