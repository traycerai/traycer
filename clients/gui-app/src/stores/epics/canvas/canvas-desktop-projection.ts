/**
 * Desktop per-window projection: pure builders that translate between the
 * epic canvas store's state and the desktop snapshot/patch shapes. No store
 * import (only the store TYPE) - `store.ts` owns the bridge wiring, the
 * subscriber, and `applyEpicCanvasDesktopProjection`, all of which consume
 * these builders.
 */
import type { EpicNodeRecord } from "@/lib/artifacts/node-display";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
} from "@/lib/windows/types";
import type { EpicCanvasState, EpicViewTab } from "./types";
import { createEmptyCanvas } from "./canvas-state";
import {
  epicCanvasStatesEqual,
  parseCanvasByTabId,
  serializeCanvasByTabId,
} from "./migrate-canvas";
import type { EpicCanvasStore } from "./store";

export const EMPTY_RECORDS: ReadonlyArray<EpicNodeRecord> = [];

export function isEpicViewTab(
  tab: EpicViewTab | undefined,
): tab is EpicViewTab {
  return tab !== undefined;
}

function buildProjectedArtifactTrees(
  tabs: readonly EpicViewTab[],
  state: Pick<EpicCanvasStore, "artifactTreeByEpicId">,
): Readonly<Record<string, ReadonlyArray<EpicNodeRecord> | undefined>> {
  const out: Record<string, ReadonlyArray<EpicNodeRecord> | undefined> = {};
  for (const tab of tabs) {
    // Shared EMPTY_RECORDS (not a fresh `[]`) so a projection echo keeps
    // identity for epics with no records and their selectors stay quiet.
    out[tab.epicId] = state.artifactTreeByEpicId[tab.epicId] ?? EMPTY_RECORDS;
  }
  return out;
}

export function projectTabsForDesktop(
  state: Pick<EpicCanvasStore, "openTabOrder" | "tabsById">,
): DesktopPerWindowStatePatch["epicTabs"] {
  return state.openTabOrder.flatMap((tabId) => {
    const tab = state.tabsById[tabId];
    return tab === undefined
      ? []
      : [{ id: tab.tabId, epicId: tab.epicId, name: tab.name }];
  });
}

export function projectCanvasByTabIdForDesktop(
  state: Pick<EpicCanvasStore, "openTabOrder" | "tabsById" | "canvasByTabId">,
): DesktopPerWindowStatePatch["canvasByTabId"] {
  return serializeCanvasByTabId(
    Object.fromEntries(
      state.openTabOrder.flatMap((tabId) => {
        const canvas = state.canvasByTabId[tabId];
        return state.tabsById[tabId] === undefined || canvas === undefined
          ? []
          : [[tabId, canvas]];
      }),
    ),
  );
}

function parseProjectedEpicTabs(snapshot: DesktopPerWindowSnapshot): {
  readonly tabsById: Readonly<Record<string, EpicViewTab | undefined>>;
  readonly canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>;
  readonly openTabOrder: ReadonlyArray<string>;
} {
  const snapshotCanvasByTabId = parseCanvasByTabId(snapshot.canvasByTabId);
  const seen = new Set<string>();
  const tabsById: Record<string, EpicViewTab> = {};
  const canvasByTabId: Record<string, EpicCanvasState> = {};
  const openTabOrder: string[] = [];
  for (const tab of snapshot.epicTabs) {
    if (seen.has(tab.id)) continue;
    // A tab's identity is its id + epicId; the stored name may legitimately be
    // empty (epics/agents created untitled - the display layer derives the
    // shown title). Only skip structurally-malformed projected entries, not
    // empty-named ones.
    if (tab.id.length === 0 || tab.epicId.length === 0) continue;
    seen.add(tab.id);
    tabsById[tab.id] = {
      tabId: tab.id,
      epicId: tab.epicId,
      name: tab.name,
    };
    canvasByTabId[tab.id] =
      snapshotCanvasByTabId[tab.id] ?? createEmptyCanvas();
    openTabOrder.push(tab.id);
  }
  return { tabsById, canvasByTabId, openTabOrder };
}

function hiddenTabsByIdForDesktopProjection(
  state: Pick<EpicCanvasStore, "openTabOrder" | "tabsById">,
): Readonly<Record<string, EpicViewTab | undefined>> {
  const visibleTabIds = new Set(state.openTabOrder);
  return Object.fromEntries(
    Object.entries(state.tabsById).filter(
      ([tabId, tab]) => tab !== undefined && !visibleTabIds.has(tabId),
    ),
  );
}

/**
 * Preserve tab-record identity across a projection: reuse the existing record
 * whenever its display metadata (`epicId` + `name`) is unchanged. The desktop
 * sync round-trip re-parses every tab into a fresh object on each interaction,
 * which otherwise churned `tabsById` identity for value-identical tabs and
 * re-rendered every `tabsById` consumer (header strip, command palette, route
 * tab). `tabId` is the map key, so only `epicId`/`name` need comparing.
 */
function reuseUnchangedTabRecords(
  next: Readonly<Record<string, EpicViewTab | undefined>>,
  current: Readonly<Record<string, EpicViewTab | undefined>>,
): Readonly<Record<string, EpicViewTab | undefined>> {
  const out: Record<string, EpicViewTab> = {};
  for (const [tabId, tab] of Object.entries(next)) {
    if (tab === undefined) continue;
    const prev = current[tabId];
    out[tabId] =
      prev !== undefined && prev.epicId === tab.epicId && prev.name === tab.name
        ? prev
        : tab;
  }
  return out;
}

function mergeMostRecentTabIdsForDesktopProjection(
  state: Pick<EpicCanvasStore, "mostRecentTabIdByEpicId">,
  tabsById: Readonly<Record<string, EpicViewTab | undefined>>,
  activeTab: EpicViewTab | null,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string> = {};
  for (const [epicId, tabId] of Object.entries(state.mostRecentTabIdByEpicId)) {
    if (tabId === undefined) continue;
    const tab = tabsById[tabId];
    if (tab?.epicId !== epicId) continue;
    out[epicId] = tabId;
  }
  if (activeTab !== null) {
    out[activeTab.epicId] = activeTab.tabId;
  }
  return out;
}

/**
 * The full store patch a desktop snapshot projection applies. Pure - the
 * store-side `applyEpicCanvasDesktopProjection` passes this to `setState`
 * inside the echo-suppression flag.
 */
export function buildDesktopProjectionPatch(
  state: EpicCanvasStore,
  snapshot: DesktopPerWindowSnapshot,
): Partial<EpicCanvasStore> {
  const projected = parseProjectedEpicTabs(snapshot);
  // The desktop sync round-trip echoes our own writes back and re-parses every
  // tab into a FRESH record on each interaction. Reuse the existing record
  // when its display metadata is unchanged so `tabsById` identity stays stable
  // - otherwise the header strip, command palette, and route tab re-render on
  // every tile open / tab switch.
  const tabsById = reuseUnchangedTabRecords(
    {
      ...hiddenTabsByIdForDesktopProjection(state),
      ...projected.tabsById,
    },
    state.tabsById,
  );
  // Keep canvas in lockstep with the rebuilt tab set: projected tabs take
  // the snapshot canvas; preserved hidden tabs keep their in-memory canvas.
  // Per-tab identity reuse: the round-trip echoes our own write back as
  // freshly-parsed canvases, so keep the CURRENT reference whenever the
  // projected canvas is structurally equal - otherwise every echo would
  // hand new identities to every pane and cascade re-renders through the
  // tiled canvas. Per-tab (not whole-map) so a cross-window edit to tab A
  // still leaves tab B's canvas identity-stable.
  const canvasByTabId = Object.fromEntries(
    Object.keys(tabsById).map((tabId) => {
      const current = state.canvasByTabId[tabId];
      const incoming = projected.canvasByTabId[tabId];
      if (incoming === undefined) {
        return [tabId, current ?? createEmptyCanvas()];
      }
      if (current !== undefined && epicCanvasStatesEqual(current, incoming)) {
        return [tabId, current];
      }
      return [tabId, incoming];
    }),
  );
  const activeTab =
    snapshot.activeTabId === null
      ? null
      : (tabsById[snapshot.activeTabId] ?? null);
  return {
    tabsById,
    canvasByTabId,
    openTabOrder: projected.openTabOrder,
    activeTabId:
      activeTab === null || !projected.openTabOrder.includes(activeTab.tabId)
        ? null
        : activeTab.tabId,
    mostRecentTabIdByEpicId: mergeMostRecentTabIdsForDesktopProjection(
      state,
      tabsById,
      activeTab,
    ),
    artifactTreeByEpicId: buildProjectedArtifactTrees(
      Object.values(tabsById).filter(isEpicViewTab),
      state,
    ),
  };
}
