import { prepareDesktopHistoryDraft, prepareSavedDraft } from "./saved-draft";
import { toast } from "sonner";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  readCanonicalLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import type { DraftAuthorityVersion } from "@/lib/drafts/draft-authority-types";
import { getDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import {
  currentDesktopDraftTopology,
  sameDesktopDraftReference,
  toDesktopLandingDraftReference,
} from "@/lib/windows/desktop-draft-topology";
import type { DesktopWindowsBridge } from "@/lib/windows/types";
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
function sameJournalItem(left: ClosedHeaderTab, right: ClosedHeaderTab): boolean {
  if (headerKey(left) !== headerKey(right)) return false;
  if (left.kind !== "draft" || right.kind !== "draft") return true;
  const one = left.draftReference;
  const other = right.draftReference;
  return (
    left.hostId === right.hostId &&
    (one === other ||
      (one !== null && one !== undefined &&
        other !== null && other !== undefined &&
        one.slotId === other.slotId && one.occurrence === other.occurrence))
  );
}

interface CommittedDesktopHistory {
  readonly revision: number;
  readonly references: readonly DraftAuthorityVersion[];
}

function desktopHistoryAliasesAreCurrent(
  bridge: DesktopWindowsBridge,
  committed: CommittedDesktopHistory,
): boolean {
  if (getDesktopEpicOwnershipBridge() !== bridge) return false;
  const topology = currentDesktopDraftTopology(bridge);
  return (
    topology !== undefined &&
    topology.revision === committed.revision &&
    committed.references.every((reference) =>
      topology.references.some((alias) =>
        sameDesktopDraftReference(alias, toDesktopLandingDraftReference(reference)),
      ),
    )
  );
}

async function canonicalHistoryVersionsAreCurrent(
  references: readonly DraftAuthorityVersion[],
): Promise<boolean> {
  const reads = await Promise.all(references.map(readCanonicalLandingDraft));
  return reads.every((read, index) =>
    read.kind === "live" && read.draft.version === references.at(index)?.version,
  );
}

async function restoreHeader(
  entry: TabRecoveryEntry,
  router: KeybindingRouter,
): Promise<RestoreOutcome> {
  const generation = recoveryHistoryGeneration();
  const { actor, admission, isCurrent: sessionIsCurrent } = captureDesktopLandingDraftPress();
  const initialPath = router.getPathname();
  const desktopBridge =
    admission.kind === "ready" ? getDesktopEpicOwnershipBridge() : null;
  const desktopPlacement =
    desktopBridge === null ? null : tabCommandCoordinator.prepareDesktopHistoryPlacement(null);
  const currentGesture = (): boolean =>
    generation === recoveryHistoryGeneration() &&
    sessionIsCurrent() &&
    router.getPathname() === initialPath &&
    (desktopBridge === null || getDesktopEpicOwnershipBridge() === desktopBridge);
  const retainedReferences = new Map<string, DraftAuthorityVersion>();
  const stillCurrent = (item: ClosedHeaderTab): boolean => {
    if (generation !== recoveryHistoryGeneration()) return false;
    const current = useTabRecoveryHistory
      .getState()
      .entries.find((candidate) => candidate.id === entry.id);
    return (
      current !== undefined &&
      current.items.some((candidate) => sameJournalItem(candidate, item))
    );
  };
  const prepared: ClosedHeaderTab[] = [];
  const failed: ClosedHeaderTab[] = [];
  const desktopDrafts: Extract<ClosedHeaderTab, { kind: "draft" }>[] = [];
  for (const item of entry.items) {
    if (item.kind === "draft" && admission.kind !== "legacy") {
      if (admission.kind === "ready" && desktopBridge !== null &&
        desktopPlacement !== null) {
        const reference = await prepareDesktopHistoryDraft({
          item,
          actor,
          isCurrent: () => currentGesture() && stillCurrent(item) && desktopPlacement.isCurrent([]),
        }).catch(() => null);
        if (reference !== null) {
          const topology = currentDesktopDraftTopology(desktopBridge);
          const exactAlias = topology?.references.some((alias) =>
            sameDesktopDraftReference(alias, toDesktopLandingDraftReference(reference)),
          );
          if (exactAlias === true && headerIsOpen(item)) continue;
          retainedReferences.set(item.draftId, reference);
        }
      }
      if (retainedReferences.has(item.draftId)) desktopDrafts.push(item);
      else failed.push(item);
      continue;
    }
    if (headerIsOpen(item)) continue;
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
  let committedDesktopHistory: CommittedDesktopHistory | null = null;
  if (
    admission.kind === "ready" && desktopBridge !== null &&
    desktopPlacement !== null && desktopDrafts.length > 0
  ) {
    const live = desktopDrafts.filter(stillCurrent);
    const references = live.flatMap((item) => {
      const reference = retainedReferences.get(item.draftId);
      return reference === undefined ? [] : [reference];
    });
    if (references.length > 0) {
      const draftIds = live.map(({ draftId }) => draftId);
      const isCurrent = (): boolean =>
        currentGesture() && live.every(stillCurrent) && desktopPlacement.isCurrent(draftIds);
      if (isCurrent() && await canonicalHistoryVersionsAreCurrent(references) && isCurrent()) {
        const result = await admission.attach({
          references,
          activateDraftId: entry.bulk ? null : (live.at(0)?.draftId ?? null),
          isCurrent,
        });
        if (result.kind === "attached" && isCurrent()) {
          const committed = { revision: result.topologyRevision, references };
          if (desktopHistoryAliasesAreCurrent(desktopBridge, committed) &&
            await canonicalHistoryVersionsAreCurrent(references) &&
            isCurrent() && desktopHistoryAliasesAreCurrent(desktopBridge, committed)) {
            committedDesktopHistory = committed;
            for (const item of live) {
              attachedDrafts.add(item.draftId);
              prepared.push(item);
            }
          }
        }
      }
      if (committedDesktopHistory === null) failed.push(...live);
    }
  }
  // Revalidate membership, not just entry id: a mixed bulk entry can survive
  // deletion of one of its tasks while a draft's image write is in flight.
  const current = useTabRecoveryHistory
    .getState()
    .entries.find((candidate) => candidate.id === entry.id);
  if (current === undefined) return { restored: false, retained: false };
  const wasAttached = (item: ClosedHeaderTab): boolean =>
    item.kind === "draft" && attachedDrafts.has(item.draftId);
  const ordered = new Map(entry.items.map((item, index) => [headerKey(item), index]));
  let items = prepared
    .filter((item) => stillCurrent(item) && (wasAttached(item) || !headerIsOpen(item)))
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
  let retained = failed.filter((item) =>
    stillCurrent(item) &&
    (!headerIsOpen(item) || (admission.kind !== "legacy" && item.kind === "draft")),
  );
  if (items.length > 0 && committedDesktopHistory !== null &&
    desktopBridge !== null && desktopPlacement !== null) {
    const draftIds = [...attachedDrafts];
    const placed =
      currentGesture() &&
      draftIds.every((id) => items.some((item) => item.kind === "draft" && item.draftId === id)) &&
      desktopPlacement.isCurrent(draftIds) &&
      desktopHistoryAliasesAreCurrent(desktopBridge, committedDesktopHistory) &&
      withoutTabRecovery(() => desktopPlacement.finish({ items, attachedDraftIds: attachedDrafts }));
    if (!placed) {
      const unplaced = [...items, ...retained];
      retained = current.items.filter((item) =>
        unplaced.some((candidate) => sameJournalItem(candidate, item)),
      );
      items = [];
    }
  } else if (items.length > 0) {
    withoutTabRecovery(() =>
      tabCommandCoordinator.restoreClosedHeaderTabs(
        items,
        admission.kind === "legacy" && !entry.bulk ? activeDraftId(router) : null,
      ),
    );
  }
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
