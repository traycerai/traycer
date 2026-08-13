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
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { queryClient } from "@/lib/query-client";
import {
  cloudChatViewerIdSnapshot,
  readCloudKnownChatIds,
} from "@/lib/chats/cloud-chat-list-cache";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * The single function every back/forward surface calls. Takes the **current**
 * router (the live instance in `<RouterProvider>`), never the module-level
 * `router` singleton from `@/router` - that throwaway carries a different,
 * inert history stack.
 *
 * Narrowed to the one field these helpers read (`history`) so callers pass
 * `useRouter()` directly and tests supply a tiny fake without an unsafe cast to
 * `AnyRouter`.
 */
export interface HistoryNavRouter {
  readonly history: RouterHistory;
}

/**
 * Step back to the nearest ELIGIBLE entry in the current router's persistent
 * history - closed-Task entries in between are skipped over, not landed on
 * (see `findEligibleOffset`). No-op when the history carries no controller
 * brand (browser/web build), so the feature is wholly inert outside
 * Electron, AND no-op when no eligible entry exists in this direction: an
 * offset-less `go` would still notify → `router.load()` re-runs the current
 * route for nothing. That no-op also keeps every input path (keyboard,
 * mouse, palette) from firing that same-route load.
 */
export function goBack(router: HistoryNavRouter): void {
  navigateHistory(router, -1);
}

/**
 * Step forward to the nearest eligible entry. See `goBack` - same
 * skip-closed-Task and boundary no-op behavior, opposite direction.
 */
export function goForward(router: HistoryNavRouter): void {
  navigateHistory(router, 1);
}

function navigateHistory(router: HistoryNavRouter, direction: -1 | 1): void {
  const controller = getHistoryController(router.history);
  if (controller === null) {
    return;
  }
  const entries = controller.getEntries();
  const index = controller.getIndex();
  const offset = findEligibleOffset(entries, index, direction, (href) =>
    isHistoryEntryEligible(href, useEpicCanvasStore.getState()),
  );
  if (offset === null) {
    return;
  }
  reopenClosedTilePreview(entries[index + offset]);
  router.history.go(offset);
  trackHistoryNavigationUsed(direction === -1 ? "back" : "forward");
}

/**
 * When the landing entry targets a tile under an OPEN Task that no longer
 * resolves, reopens that tile as a preview BEFORE the router navigation
 * fires. Reuses the preserved payload's ORIGINAL `instanceId` (not a fresh
 * one) and prefers the href's own `paneId` when that pane still exists, so
 * the landing href's exact `(paneId, tileInstanceId)` resolves directly on
 * navigation - no URL-rewrite churn, and no risk of landing in an unrelated
 * pane and evicting its preview. Falls back to the active pane (and the
 * route's stale-target canonicalization) only when the original pane is
 * gone. This is the "closed sub-tab of an open Task" case from the behavior
 * spec.
 *
 * Before restoring, two checks can prove the payload permanently unusable
 * and drop it (`discardClosedTilePayload`), treating it as a cache miss -
 * navigation still proceeds, just without the reopen, and the existing
 * stale-route restore takes over exactly as it did before this feature
 * existed:
 *
 * 1. `state.selfDeletedArtifactIds` (global, content-id-keyed) - a
 *    successful LOCAL delete tombstones its id here regardless of whether
 *    the tile's epic session is currently live, so it's checked first and
 *    unconditionally.
 * 2. `isTileRefRecordLive` - the SAME predicate `useEpicRouteSynchronization`'s
 *    cleanup effect uses to close a tile whose backing record was deleted
 *    while it was OPEN. A record can just as well be deleted while the tile
 *    is CLOSED (no open tile for that effect to catch), so this is validated
 *    again here, at restore time, regardless of how or when the payload was
 *    captured. Presence is checked via the live open-Epic session's
 *    projected tree (`getOpenEpicRegistry().peek(epicId)` - `peek`, not
 *    `get`: this is a passive check, not a genuine session open, so it must
 *    not bump the session's MRU recency). Neither "no session live" NOR "a
 *    session exists but its snapshot hasn't loaded yet" (freshly
 *    (re)acquired handle, `tree` still empty) can prove the record is gone,
 *    or a payload captured while its record was still pending projection can
 *    prove the record is gone (the cache keeps that pending marker until the
 *    create flow explicitly clears it). Matching this codebase's conservative
 *    destroy-only-what-a-store-proves-dead liveness rule (`liveness.ts`) -
 *    both are treated as live rather than blocking the restore. A REMOTE
 *    deletion with no live session and no local tombstone is unknowable here
 *    - accepted: the stale restore that can follow is loop-safe (route sync
 *    closes it and canonicalizes once its session loads).
 */
/**
 * Whether a preserved closed-tile payload still names a record worth
 * restoring. Lifted out of {@link reopenClosedTilePreview}, whose guard
 * sequence was over this repo's complexity ceiling; the checks and their order
 * are unchanged.
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
  const activeHostId =
    getHostBindingSnapshot()?.hostClient.getActiveHostId() ?? null;
  return isTileRefRecordLive(
    preserved.node,
    pendingCreateArtifactIds,
    {
      hasLiveRecord,
      isCloudKnown: cloudKnownPredicate(activeHostId, epicId),
    },
    activeHostId,
  );
}

/**
 * The same-host cloud-known exemption, on the one path that has no hooks.
 *
 * The route-sync reap and the tab-group-view substitution both get this from a
 * mounted `useCloudChatList`. This path cannot: it runs inside a synchronous
 * `history.go` and must answer before the navigation fires. It therefore reads
 * the slot that hook has already filled - which is not a fallback so much as the
 * same answer, since the epic tab whose href we are landing on is by definition
 * open, and its route synchronization mounts that very query for this epic.
 *
 * `null` from the cache reader is "no answer that may be acted on", and it maps
 * to a predicate that says LIVE for every id. Absence of evidence is not
 * evidence here, and the asymmetry of the two mistakes is what decides it:
 * refusing the restore calls `discardClosedTilePayload`, which drops the
 * preserved payload permanently, while restoring a tile whose record really is
 * gone is loop-safe - route sync closes it and canonicalizes the URL, exactly as
 * documented for the remote-deletion case above. It is also the rule
 * `hasLiveRecord` already follows two lines up, where neither "no live session"
 * nor "snapshot not loaded yet" is allowed to prove a record gone.
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
