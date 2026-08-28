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
 * Step back to the previous entry in the current router's history.
 *
 * TWO BACKENDS, chosen by what the history can answer rather than by which
 * shell is asking. A history carrying the controller brand owns its entry list,
 * so the step can be semantic: closed-Task entries in between are skipped over
 * rather than landed on (see `findEligibleOffset`), the landing entry's tile is
 * restored first, and a step with no eligible entry is refused outright,
 * because an offset-less `go` would still notify → `router.load()` re-runs the
 * current route for nothing.
 *
 * A plain history exposes no entries and no index, so none of that is knowable
 * and none of it is attempted: the step is handed straight to the history, which
 * either moves or does nothing. That is the whole fallback, and it serves only
 * the browser web app - the desktop renderer and the installed mobile app both
 * run the branded history, so their steps are always the semantic kind.
 */
export function goBack(router: HistoryNavRouter): void {
  navigateHistory(router, -1);
}

/**
 * Step forward to the next entry. See `goBack` - same two backends, opposite
 * direction.
 */
export function goForward(router: HistoryNavRouter): void {
  navigateHistory(router, 1);
}

export interface EligibleHistoryTarget {
  /** Position in the controller's entry list, for the `go` offset. */
  readonly index: number;
  /**
   * The entry's stable identity, for keying per-entry state. `null` when the
   * entry's state carries no readable key - such an entry can still be landed
   * on, but nothing can be reliably filed against it.
   */
  readonly key: string | null;
}

/**
 * The entry a semantic step would land on, or `null` when the step would be
 * refused - no eligible entry in that direction, or a history that owns no
 * entry list (the plain backend, whose landing is unknowable before it moves).
 *
 * Read-only twin of the step itself, exported for the surface that must know
 * the landing BEFORE navigating: the swipe transition puts the destination
 * screen under the finger for the whole drag, and a destination assumed to be
 * "one entry over" shows the wrong screen whenever the step would actually
 * skip ineligible entries. Answering from the same scan `navigateHistory`
 * performs is what keeps the animated screen and the landed screen the same
 * screen.
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

/**
 * The step a history with no controller brand can make.
 *
 * `canGoBack` is the one navigability question such a history answers - it
 * reads the index the router stamps into each entry's state - and it is asked
 * because a back at the first entry is not merely a no-op: under a WebView it
 * is a step out of the session's own stack.
 *
 * Forward has no counterpart to ask. The history exposes no length ahead of the
 * cursor, so "is there anything to go forward to" is UNKNOWABLE here, and the
 * step is issued unconditionally: the browser moves if there is somewhere to
 * move and does nothing if there is not. Guessing in either direction would be
 * worse than attempting - refusing would make forward permanently dead, and
 * reporting it as available would light up a control that leads nowhere.
 *
 * Analytics follows the same asymmetry. A back is counted only once it is
 * actually issued; a forward counts the attempt, because nothing here can tell
 * an attempt that moved from one that did not.
 */
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
  // The host whose projection supplies `hasLiveRecord`: the Epic SESSION's
  // stamped host, falling back to the app-wide effective host only when no
  // session is live (the imperative twin of `useCanvasHostId`, and the same
  // identity `useEpicRouteSynchronization` polices with). The two differ for
  // the whole of a re-point that is establishing or one that failed - the
  // provider keeps the previous handle rendered, so `records` are still host
  // A's while the app-wide pointer says B. Reading B here would (a) trip
  // `isTileRefRecordLive`'s cross-host exemption for every A-bound chat, so the
  // record check this guard exists to run never runs, and (b) ask the
  // cloud-known cache under B, a slot no writer for this Epic fills any more.
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
