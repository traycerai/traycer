import { prepareSavedDraft } from "./saved-draft";
import { restoreClosedCanvas } from "./restore-canvas";
import { toast } from "sonner";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { findPaneById, collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  draftTabIntent,
  existingEpicTabIntentWithNestedFocus,
} from "@/lib/tab-navigation/intents";
import { preservedTileRecordIsLive } from "@/lib/commands/actions/history-navigation";
import { rejectClosedPlainTerminalRestore } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { queryClient } from "@/lib/query-client";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { parseEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import {
  useTabRecoveryHistory,
  removeRecoveryEntry,
  updateRecoveryEntry,
  recoveryHistoryGeneration,
  withoutTabRecovery,
  type ClosedHeaderTab,
  type TabRecoveryEntry,
} from "./history";

let reopening = false;
function tileIsRecoverable(tile: EpicCanvasTileRef, epicId: string): boolean {
  const state = useEpicCanvasStore.getState();
  if (state.selfDeletedArtifactIds.has(tile.id)) return false;
  if (rejectClosedPlainTerminalRestore({ queryClient, epicId, node: tile }))
    return false;
  return preservedTileRecordIsLive(
    { node: tile, pendingCreate: state.pendingCreateArtifactIds.has(tile.id) },
    epicId,
    state.pendingCreateArtifactIds,
  );
}
function cleanCanvas(canvas: EpicCanvasState, epicId: string): EpicCanvasState {
  const tilesByInstanceId = Object.fromEntries(
    Object.entries(canvas.tilesByInstanceId).filter(
      ([, tile]) => tile !== undefined && tileIsRecoverable(tile, epicId),
    ),
  );
  return parseEpicCanvasState({ ...canvas, tilesByInstanceId }) ?? canvas;
}
function activateEpic(
  router: KeybindingRouter,
  epicId: string,
  tabId: string,
): void {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  const pane =
    canvas === undefined
      ? null
      : findPaneById(canvas.root, canvas.activePaneId ?? "");
  router.navigateToTabIntent(
    existingEpicTabIntentWithNestedFocus({
      epicId,
      tabId,
      focus: undefined,
      nestedFocus:
        pane === null
          ? null
          : { paneId: pane.id, tileInstanceId: pane.activeTabId ?? undefined },
    }),
  );
}
function activeDraftId(router: KeybindingRouter): string | null {
  return /^\/draft\/([^/]+)$/.exec(router.getPathname())?.[1] ?? null;
}
interface RestoreOutcome {
  readonly restored: boolean;
  readonly retained: boolean;
}
function headerKey(item: ClosedHeaderTab): string {
  return item.kind === "epic"
    ? `epic:${item.tab.tabId}`
    : `draft:${item.draftId}`;
}
function headerIsOpen(item: ClosedHeaderTab): boolean {
  if (item.kind === "draft")
    return useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === item.draftId && !draft.closed);
  const state = useEpicCanvasStore.getState();
  const existing = state.tabsById[item.tab.tabId];
  return (
    state.openTabOrder.includes(item.tab.tabId) ||
    (existing !== undefined && existing.epicId !== item.tab.epicId)
  );
}
async function prepareHeaderItem(
  item: ClosedHeaderTab,
  stillCurrent: () => boolean,
): Promise<ClosedHeaderTab | null> {
  if (item.kind === "draft") {
    if (!(await prepareSavedDraft(item, stillCurrent))) return null;
    return {
      kind: "draft",
      draftId: item.draftId,
      hostId: item.hostId,
      index: item.index,
      ...(item.placement === undefined ? {} : { placement: item.placement }),
    };
  }
  const canvas =
    useEpicCanvasStore.getState().canvasByTabId[item.tab.tabId] ?? item.canvas;
  return { ...item, canvas: cleanCanvas(canvas, item.tab.epicId) };
}
async function restoreHeader(
  entry: Extract<TabRecoveryEntry, { kind: "header" }>,
  router: KeybindingRouter,
): Promise<RestoreOutcome> {
  const generation = recoveryHistoryGeneration();
  const stillCurrent = (item: ClosedHeaderTab): boolean => {
    if (generation !== recoveryHistoryGeneration()) return false;
    const current = useTabRecoveryHistory
      .getState()
      .entries.find((candidate) => candidate.id === entry.id);
    return (
      current?.kind === "header" &&
      current.items.some(
        (candidate) => headerKey(candidate) === headerKey(item),
      )
    );
  };
  const prepared: ClosedHeaderTab[] = [];
  const failed: ClosedHeaderTab[] = [];
  for (const item of entry.items) {
    if (headerIsOpen(item)) continue;
    try {
      const ready = await prepareHeaderItem(item, () => stillCurrent(item));
      if (ready !== null) prepared.push(ready);
    } catch {
      failed.push(item);
    }
  }
  // Revalidate membership, not just entry id: a mixed bulk entry can survive
  // deletion of one of its tasks while a draft's image write is in flight.
  const current = useTabRecoveryHistory
    .getState()
    .entries.find((candidate) => candidate.id === entry.id);
  if (current?.kind !== "header") return { restored: false, retained: false };
  const keys = new Set(current.items.map(headerKey));
  const items = prepared
    .filter((item) => keys.has(headerKey(item)) && !headerIsOpen(item))
    .map((item) => {
      if (item.kind === "draft") return item;
      const latest = current.items.find(
        (candidate) => headerKey(candidate) === headerKey(item),
      );
      const canvas =
        useEpicCanvasStore.getState().canvasByTabId[item.tab.tabId] ??
        (latest?.kind === "epic" ? latest.canvas : item.canvas);
      return { ...item, canvas: cleanCanvas(canvas, item.tab.epicId) };
    });
  const retained = failed.filter(
    (item) => keys.has(headerKey(item)) && !headerIsOpen(item),
  );
  if (items.length > 0)
    withoutTabRecovery(() =>
      tabCommandCoordinator.restoreClosedHeaderTabs(
        items,
        entry.bulk ? null : activeDraftId(router),
      ),
    );
  if (retained.length > 0) {
    updateRecoveryEntry({ ...current, items: retained });
    toast.info(
      items.length > 0
        ? "Some tabs couldn't be reopened"
        : "Couldn't reopen the closed tab",
      {
        description:
          "Their recovery information has been kept. Try again when the content is available.",
      },
    );
  }
  const first = items.at(0);
  if (!entry.bulk && first !== undefined) {
    if (first.kind === "epic")
      activateEpic(router, first.tab.epicId, first.tab.tabId);
    else router.navigateToTabIntent(draftTabIntent(first.draftId));
  }
  return { restored: items.length > 0, retained: retained.length > 0 };
}
/** cmdk remounts must not transfer ownership to an empty sibling pane. */
function releasePaneOpenerFocus(tabId: string, focus: boolean): () => void {
  if (typeof document === "undefined") return () => undefined;
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) return () => undefined;
  const opener = element.closest('[data-testid="pane-opener"]');
  if (opener === null) return () => undefined;
  const paneId = opener.getAttribute("data-group-id");
  // cmdk focuses its own input on mount whenever ANY cmdk input held focus.
  // A restored split remounts empty siblings, even when they are inactive.
  element.blur();
  return () => {
    if (focus) return;
    window.requestAnimationFrame(() => {
      // Bulk recovery preserves keyboard focus too. A remounted active opener
      // handles its own autofocus; restore a surviving input only while no
      // later user action has moved focus or changed the active pane.
      if (
        element.isConnected &&
        document.activeElement === document.body &&
        useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ===
          paneId
      )
        element.focus({ preventScroll: true });
    });
  };
}
interface CanvasRecoveryTargets {
  readonly instanceIds: readonly string[];
  readonly paneIds: readonly string[];
}

function canvasRecoveryTargets(
  entry: Extract<TabRecoveryEntry, { kind: "canvas" }>,
): CanvasRecoveryTargets | null {
  const state = useEpicCanvasStore.getState();
  // View ids are globally unique. A moved view is not a new close and must
  // never be claimed by recovery in its former owner.
  const liveIds = new Set(
    Object.values(state.canvasByTabId).flatMap((canvas) =>
      canvas === undefined
        ? []
        : collectPanes(canvas.root).flatMap((pane) => pane.tabInstanceIds),
    ),
  );
  const instanceIds = entry.instanceIds.filter((id) => {
    const tile = entry.before.tilesByInstanceId[id];
    return (
      !liveIds.has(id) &&
      tile !== undefined &&
      tileIsRecoverable(tile, entry.tab.epicId)
    );
  });
  const paneIds = (entry.paneIds ?? []).filter(
    (id) =>
      !Object.values(state.canvasByTabId).some(
        (canvas) =>
          canvas !== undefined && findPaneById(canvas.root, id) !== null,
      ),
  );
  if (instanceIds.length === 0) {
    if (paneIds.length === 0) return null;
    const current = state.canvasByTabId[entry.tab.tabId] ?? entry.after;
    if (
      restoreClosedCanvas(current, entry.before, entry.after, {
        instanceIds,
        paneIds,
        focus: false,
      }) === current
    )
      return null;
  }
  return { instanceIds, paneIds };
}

function restoreCanvas(
  entry: Extract<TabRecoveryEntry, { kind: "canvas" }>,
  router: KeybindingRouter,
): boolean {
  const state = useEpicCanvasStore.getState();
  const targets = canvasRecoveryTargets(entry);
  if (targets === null) return false;
  const { instanceIds, paneIds } = targets;
  if (!state.openTabOrder.includes(entry.tab.tabId)) {
    withoutTabRecovery(() =>
      tabCommandCoordinator.restoreClosedHeaderTabs(
        [
          {
            kind: "epic",
            tab: entry.tab,
            canvas: cleanCanvas(
              state.canvasByTabId[entry.tab.tabId] ?? entry.after,
              entry.tab.epicId,
            ),
            index: state.openTabOrder.length,
          },
        ],
        activeDraftId(router),
      ),
    );
  }
  const sameTask =
    router.getPathname() === `/epics/${entry.tab.epicId}/${entry.tab.tabId}`;
  const focus = !entry.bulk || !sameTask;
  const restore = () => {
    const restoreOpenerFocus = releasePaneOpenerFocus(entry.tab.tabId, focus);
    useEpicCanvasStore.getState().restoreCanvasForRecovery(entry.tab.tabId, {
      before: entry.before,
      after: entry.after,
      instanceIds,
      paneIds,
      focus,
    });
    restoreOpenerFocus();
    const canvas = useEpicCanvasStore.getState().canvasByTabId[entry.tab.tabId];
    const pane =
      canvas === undefined
        ? null
        : findPaneById(canvas.root, canvas.activePaneId ?? "");
    return pane === null
      ? null
      : { paneId: pane.id, tileInstanceId: pane.activeTabId ?? undefined };
  };
  if (focus && sameTask && router.navigateNestedFocus !== undefined)
    router.navigateNestedFocus(entry.tab.epicId, entry.tab.tabId, restore);
  else {
    restore();
    if (focus) activateEpic(router, entry.tab.epicId, entry.tab.tabId);
  }
  return true;
}
export async function reopenClosedTab(router: KeybindingRouter): Promise<void> {
  if (reopening || !useTabRecoveryHistory.getState().ready) return;
  reopening = true;
  const generation = recoveryHistoryGeneration();
  try {
    for (;;) {
      const entry = useTabRecoveryHistory.getState().entries.at(-1);
      if (entry === undefined) return;
      const outcome =
        entry.kind === "header"
          ? await restoreHeader(entry, router)
          : { restored: restoreCanvas(entry, router), retained: false };
      if (generation !== recoveryHistoryGeneration()) return;
      if (!outcome.retained) removeRecoveryEntry(entry.id);
      scheduleLandingImageReconcile();
      if (outcome.restored || outcome.retained) return;
    }
  } catch {
    toast.info("Couldn't reopen the closed tab", {
      description:
        "Its recovery information has been kept. Try again when the content is available.",
    });
  } finally {
    reopening = false;
  }
}
