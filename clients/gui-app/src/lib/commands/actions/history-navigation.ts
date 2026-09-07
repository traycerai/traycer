import type { RouterHistory } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";
import {
  findEligibleOffset,
  isHistoryEntryEligible,
  parseEpicTabHref,
} from "@/lib/history-navigation";
import {
  parseNestedFocusTargetFromHref,
  resolveNestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
import {
  useEpicCanvasStore,
  type ClosedTilePayload,
} from "@/stores/epics/canvas/store";
import { isTileRefRecordLive } from "@/stores/epics/canvas/canvas-selectors";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { getAppHostClientSnapshot } from "@/lib/host/runtime";
import { queryClient } from "@/lib/query-client";
import { rejectClosedPlainTerminalRestore } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import {
  cloudChatViewerIdSnapshot,
  readCloudKnownChatIds,
} from "@/lib/chats/cloud-chat-list-cache";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * The single function every back/forward surface calls.
 * Takes the **current** router (the live instance in `<RouterProvider>`), never the module-level `router` singleton from `@/router` - that throwaway carries a different, inert history stack.
 */
export interface HistoryNavRouter {
  readonly history: RouterHistory;
}

/** Step back to the previous entry in the current router's history. */
export function goBack(router: HistoryNavRouter): void {
  navigateHistory(router, -1);
}

/**
 * Step forward to the next entry.
 * See `goBack` - same two backends, opposite direction.
 */
export function goForward(router: HistoryNavRouter): void {
  navigateHistory(router, 1);
}

export interface EligibleHistoryTarget {
  /** Position in the controller's entry list, for the `go` offset. */
  readonly index: number;
  /**
   * The entry's stable identity, for keying per-entry state.
   * `null` when the entry's state carries no readable key - such an entry can still be landed on, but nothing can be reliably filed against it.
   */
  readonly key: string | null;
}

/**
 * The entry a semantic step would land on, or `null` when the step would be refused - no eligible entry in that direction, or a history that owns no entry list (the plain backend, whose landing is unknowable before it moves).
 */
export function resolveEligibleHistoryTarget(
  router: HistoryNavRouter,
  direction: -1 | 1,
): EligibleHistoryTarget | null {
  const controller = getHistoryController(router.history);
  if (controller === null) return null;
  const index = controller.getIndex();
  const offset = findEligibleOffset(
    controller.getEntries(),
    index,
    direction,
    (href) => isHistoryEntryEligible(href, useEpicCanvasStore.getState()),
  );
  if (offset === null) return null;
  const target = index + offset;
  return { index: target, key: controller.getEntryKeys()[target] ?? null };
}

function navigateHistory(router: HistoryNavRouter, direction: -1 | 1): void {
  const controller = getHistoryController(router.history);
  if (controller === null) {
    stepPlainHistory(router.history, direction);
    return;
  }
  const target = resolveEligibleHistoryTarget(router, direction);
  if (target === null) {
    return;
  }
  reopenClosedTilePreview(controller.getEntries()[target.index]);
  router.history.go(target.index - controller.getIndex());
  trackHistoryNavigationUsed(direction === -1 ? "back" : "forward");
}

/** The step a history with no controller brand can make. */
function stepPlainHistory(history: RouterHistory, direction: -1 | 1): void {
  if (direction === -1) {
    if (!history.canGoBack()) {
      return;
    }
    history.back();
    trackHistoryNavigationUsed("back");
    return;
  }
  history.forward();
  trackHistoryNavigationUsed("forward");
}

/**
 * Restore guards: local delete tombstones always win; treat unknown/unloaded as live.
 * Peek the epic session (do not bump MRU).
 */
function preservedTileRecordIsLive(
  preserved: ClosedTilePayload,
  epicId: string,
  pendingCreateArtifactIds: ReadonlySet<string>,
): boolean {
  if (preserved.pendingCreate) return true;
  const epicHandle = getOpenEpicRegistry().peek(epicId);
  const hasLiveRecord =
    epicHandle !== null && epicHandle.store.getState().snapshotLoaded
      ? (id: string) =>
          Object.hasOwn(epicHandle.store.getState().tree.nodeById, id)
      : () => true;
  // The host whose projection supplies `hasLiveRecord`: the Epic SESSION's stamped host, falling back to the app-wide effective host only when no session is live (the imperative twin of `useCanvasHostId`, and the same identity `useEpicRouteSynchronization`.
  const activeHostId =
    (epicHandle === null ? null : getEpicSessionHandleHostId(epicHandle)) ??
    getAppHostClientSnapshot()?.getActiveHostId() ??
    null;
  const recordListAuthorizesChatAbsence =
    epicHandle?.store.getState().chatRecordListAuthoritative ?? false;
  return isTileRefRecordLive(
    preserved.node,
    pendingCreateArtifactIds,
    {
      hasLiveRecord,
      isCloudKnown: cloudKnownPredicate(activeHostId, epicId),
      recordListAuthorizesChatAbsence,
    },
    activeHostId,
  );
}

/**
 * Reads the mounted cloud-chat list cache; `null` maps to live-for-every-id (absence is not evidence).
 */
function cloudKnownPredicate(
  activeHostId: string | null,
  epicId: string,
): (id: string) => boolean {
  const cloudKnownIds = readCloudKnownChatIds(queryClient, {
    hostId: activeHostId,
    viewerUserId: cloudChatViewerIdSnapshot(),
    taskId: epicId,
  });
  if (cloudKnownIds === null) return () => true;
  return (id: string) => cloudKnownIds.has(id);
}

function reopenClosedTilePreview(href: string): void {
  const epicTab = parseEpicTabHref(href);
  if (epicTab === null) {
    return;
  }
  const nestedTarget = parseNestedFocusTargetFromHref(href);
  if (nestedTarget === null || nestedTarget.tileInstanceId === undefined) {
    return;
  }
  const state = useEpicCanvasStore.getState();
  if (!state.openTabOrder.includes(epicTab.tabId)) {
    return;
  }
  const canvas = state.canvasByTabId[epicTab.tabId];
  const alreadyResolves =
    canvas !== undefined &&
    resolveNestedFocusTarget(canvas, nestedTarget) !== null;
  if (alreadyResolves) {
    return;
  }
  const preserved =
    state.closedTilePayloadsByTabId[epicTab.tabId]?.[
      nestedTarget.tileInstanceId
    ];
  if (preserved === undefined) {
    return;
  }
  if (state.selfDeletedArtifactIds.has(preserved.node.id)) {
    state.discardClosedTilePayload(epicTab.tabId, nestedTarget.tileInstanceId);
    return;
  }
  if (
    rejectClosedPlainTerminalRestore({
      queryClient,
      epicId: epicTab.epicId,
      node: preserved.node,
    })
  ) {
    return;
  }
  if (
    !preservedTileRecordIsLive(
      preserved,
      epicTab.epicId,
      state.pendingCreateArtifactIds,
    )
  ) {
    state.discardClosedTilePayload(epicTab.tabId, nestedTarget.tileInstanceId);
    return;
  }
  const preferredPaneId =
    canvas !== undefined &&
    findPaneById(canvas.root, nestedTarget.paneId) !== null
      ? nestedTarget.paneId
      : null;
  state.restoreClosedTilePreview(
    epicTab.tabId,
    preferredPaneId,
    preserved.node,
  );
}

type HistoryNavigationDirection = "back" | "forward";

function trackHistoryNavigationUsed(
  direction: HistoryNavigationDirection,
): void {
  globalThis.setTimeout(() => {
    try {
      Analytics.getInstance().track(AnalyticsEvent.HistoryNavigationUsed, {
        direction,
      });
    } catch {
      // Analytics is best-effort and must never affect navigation.
    }
  }, 0);
}
