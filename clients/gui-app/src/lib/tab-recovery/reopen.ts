import { prepareDesktopHistoryDraft, prepareSavedDraft } from "./saved-draft";
import { toast } from "sonner";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  captureCanonicalLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import type { DraftAuthorityReference } from "@/lib/drafts/draft-authority-types";
import { captureDesktopLandingDraftPress } from "@/lib/drafts/attach-desktop-landing-draft";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import {
  draftTabIntent,
  existingEpicTabIntentWithNestedFocus,
} from "@/lib/tab-navigation/intents";
import { preservedTileRecordIsLive } from "@/lib/commands/actions/history-navigation";
import { rejectClosedPlainTerminalRestore } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { queryClient } from "@/lib/query-client";
import { parseEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
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
function tileIsRecoverable(tile: EpicCanvasTileRef, tab: EpicViewTab): boolean {
  const state = useEpicCanvasStore.getState();
  // Successful deletions prune recovery by task/type/host identity. The
  // legacy global bare-ID set can also name unrelated content on another host.
  if (
    rejectClosedPlainTerminalRestore({
      queryClient,
      epicId: tab.epicId,
      node: tile,
    })
  )
    return false;
  const preserved =
    state.closedTilePayloadsByTabId[tab.tabId]?.[tile.instanceId];
  return preservedTileRecordIsLive(
    {
      node: tile,
      pendingCreate:
        preserved?.pendingCreate === true ||
        state.pendingCreateArtifactIds.has(tile.id),
    },
    tab.epicId,
    state.pendingCreateArtifactIds,
  );
}
function cleanCanvas(
  canvas: EpicCanvasState,
  tab: EpicViewTab,
): EpicCanvasState {
  const tilesByInstanceId = Object.fromEntries(
    Object.entries(canvas.tilesByInstanceId).filter(
      ([, tile]) => tile !== undefined && tileIsRecoverable(tile, tab),
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
async function restoreHeader(
  entry: TabRecoveryEntry,
  router: KeybindingRouter,
): Promise<RestoreOutcome> {
  const generation = recoveryHistoryGeneration();
  const { actor, admission, isCurrent: sessionIsCurrent } = captureDesktopLandingDraftPress();
  const initialPath = router.getPathname();
  const currentGesture = (): boolean =>
    generation === recoveryHistoryGeneration() && sessionIsCurrent() &&
    router.getPathname() === initialPath;
  const retainedReferences = new Map<string, DraftAuthorityReference>();
  if (admission.kind === "ready") {
    for (const item of entry.items) {
      if (item.kind !== "draft" || headerIsOpen(item)) continue;
      const reference = captureCanonicalLandingDraft(item.draftId);
      if (reference !== null) retainedReferences.set(item.draftId, reference);
    }
  }
  const stillCurrent = (item: ClosedHeaderTab): boolean => {
    if (generation !== recoveryHistoryGeneration()) return false;
    const current = useTabRecoveryHistory
      .getState()
      .entries.find((candidate) => candidate.id === entry.id);
    return (
      current !== undefined &&
      current.items.some(
        (candidate) => headerKey(candidate) === headerKey(item),
      )
    );
  };
  const prepared: ClosedHeaderTab[] = [];
  const failed: ClosedHeaderTab[] = [];
  const desktopDrafts: Extract<ClosedHeaderTab, { kind: "draft" }>[] = [];
  for (const item of entry.items) {
    if (headerIsOpen(item)) continue;
    if (item.kind === "draft" && admission.kind !== "legacy") {
      if (admission.kind === "ready" && !retainedReferences.has(item.draftId)) {
        const reference = await prepareDesktopHistoryDraft({
          item,
          actor,
          isCurrent: () => currentGesture() && stillCurrent(item),
        }).catch(() => null);
        if (reference !== null) retainedReferences.set(item.draftId, reference);
      }
      if (retainedReferences.has(item.draftId)) desktopDrafts.push(item);
      else failed.push(item);
      continue;
    }
    try {
      if (
        item.kind === "draft" &&
        !(await prepareSavedDraft(item, () => stillCurrent(item)))
      )
        continue;
      prepared.push(item);
    } catch {
      failed.push(item);
    }
  }
  const attachedDrafts = new Set<string>();
  if (admission.kind === "ready" && desktopDrafts.length > 0) {
    const live = desktopDrafts.filter(stillCurrent);
    const references = live.flatMap((item) => {
      const reference = retainedReferences.get(item.draftId);
      return reference === undefined ? [] : [reference];
    });
    if (references.length > 0) {
      const isCurrent = (): boolean => currentGesture() && live.every(stillCurrent);
      const result = await admission.attach({
        references,
        activateDraftId: entry.bulk ? null : (live[0]?.draftId ?? null),
        isCurrent,
      }).catch(() => ({ kind: "unavailable" as const }));
      if (result.kind === "attached" && isCurrent()) {
        for (const item of live) {
          attachedDrafts.add(item.draftId);
          prepared.push(item);
        }
      } else {
        failed.push(...live);
      }
    }
  }
  // Revalidate membership, not just entry id: a mixed bulk entry can survive
  // deletion of one of its tasks while a draft's image write is in flight.
  const current = useTabRecoveryHistory
    .getState()
    .entries.find((candidate) => candidate.id === entry.id);
  if (current === undefined) return { restored: false, retained: false };
  const keys = new Set(current.items.map(headerKey));
  const wasAttached = (item: ClosedHeaderTab): boolean =>
    item.kind === "draft" && attachedDrafts.has(item.draftId);
  const ordered = new Map(entry.items.map((item, index) => [headerKey(item), index]));
  const items = prepared
    .filter((item) => keys.has(headerKey(item)) && (wasAttached(item) || !headerIsOpen(item)))
    .sort((left, right) => (ordered.get(headerKey(left)) ?? 0) - (ordered.get(headerKey(right)) ?? 0))
    .map((item) => {
      if (item.kind === "draft") return item;
      const latest = current.items.find(
        (candidate) => headerKey(candidate) === headerKey(item),
      );
      const canvas =
        useEpicCanvasStore.getState().canvasByTabId[item.tab.tabId] ??
        (latest?.kind === "epic" ? latest.canvas : item.canvas);
      return { ...item, canvas: cleanCanvas(canvas, item.tab) };
    });
  const retained = failed.filter(
    (item) => keys.has(headerKey(item)) && !headerIsOpen(item),
  );
  const needsOrdinaryPlacement = items.filter((item) => !wasAttached(item));
  if (needsOrdinaryPlacement.length > 0)
    withoutTabRecovery(() =>
      tabCommandCoordinator.restoreClosedHeaderTabs(
        needsOrdinaryPlacement,
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
export async function reopenClosedTab(router: KeybindingRouter): Promise<void> {
  if (reopening || !useTabRecoveryHistory.getState().ready) return;
  reopening = true;
  const generation = recoveryHistoryGeneration();
  try {
    for (;;) {
      const entry = useTabRecoveryHistory.getState().entries.at(-1);
      if (entry === undefined) return;
      const outcome = await restoreHeader(entry, router);
      if (generation !== recoveryHistoryGeneration()) return;
      if (!outcome.retained) removeRecoveryEntry(entry.id);
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
